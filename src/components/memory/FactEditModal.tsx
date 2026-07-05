/**
 * FactEditModal - 事实编辑模态框
 * 
 * 用于编辑事实，包含：
 * - 类别下拉选择
 * - 内容多行文本框
 * - 来源信息（只读 + 跳转）
 * - 警告提示
 */

import { useState, useEffect, useCallback } from 'react';
import { CircleAlert } from 'lucide-react';
import styles from './FactEditModal.module.css';
import type { FactEditModalProps } from './types';
import type { LongTermFactCategory } from '@services/memory/types';
import { CATEGORY_OPTIONS, CATEGORY_DISPLAY_MAP } from './types';
import { getLogger } from '@services/logger';
import { useI18n } from '@/i18n';
import { Select } from '@components/ui';

const logger = getLogger('FactEditModal');

function getCategoryLabel(category: LongTermFactCategory, t: ReturnType<typeof useI18n>['t']) {
    switch (category) {
        case 'identity_role':
            return t('memory.category.identityRole');
        case 'preference_style':
            return t('memory.category.preferenceStyle');
        case 'long_term_goal':
            return t('memory.category.longTermGoal');
        case 'knowledge_level':
            return t('memory.category.knowledgeLevel');
        case 'interaction_signals':
            return t('memory.category.interactionSignals');
        case 'task_experience':
            return t('memory.category.taskExperience');
        default:
            return category;
    }
}

export function FactEditModal({
    isOpen,
    mode = 'edit',
    factId,
    initialContent = '',
    initialCategory = 'preference_style',
    sourceDescription,
    onClose,
    onSave,
}: FactEditModalProps) {
    const { t } = useI18n();
    const isCreateMode = mode === 'create';
    // 表单状态
    const [content, setContent] = useState(initialContent);
    const [category, setCategory] = useState<LongTermFactCategory>(initialCategory);
    const [isSaving, setIsSaving] = useState(false);

    // 初始化表单
    useEffect(() => {
        if (isOpen) {
            setContent(initialContent);
            setCategory(initialCategory);
            setIsSaving(false);
        }
    }, [isOpen, initialContent, initialCategory]);

    // Escape 关闭
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isOpen && e.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // 点击遮罩关闭
    const handleOverlayClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    }, [onClose]);

    // 保存
    const handleSave = useCallback(async () => {
        const trimmedContent = content.trim();
        if (!trimmedContent || (!isCreateMode && !factId)) return;

        setIsSaving(true);
        try {
            await onSave(isCreateMode ? null : factId, trimmedContent, category);
            onClose();
        } catch (err) {
            logger.error('保存事实失败:', err);
        } finally {
            setIsSaving(false);
        }
    }, [factId, content, category, onSave, onClose, isCreateMode]);

    if (!isOpen) {
        return null;
    }

    return (
        <div className={styles.overlay} onClick={handleOverlayClick}>
            <div className={styles.modal} role="dialog" aria-modal="true">
                {/* 头部 */}
                <div className={styles.header}>
                    <h3 className={styles.title}>
                        {isCreateMode ? t('memory.addFact') : t('memory.editFact')}
                    </h3>
                    <button
                        className={styles.closeBtn}
                        onClick={onClose}
                        aria-label={t('common.close')}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M4 4l8 8M12 4L4 12" />
                        </svg>
                    </button>
                </div>

                {/* 内容 */}
                <div className={styles.content}>
                    {/* 类别选择 */}
                    <div className={styles.formGroup}>
                        <label className={styles.label}>{t('memory.factCategory')}</label>
                        <Select
                            className={styles.select}
                            value={category}
                            onValueChange={(value) => setCategory(value as LongTermFactCategory)}
                            options={CATEGORY_OPTIONS.map((opt) => ({
                                value: opt.value,
                                label: getCategoryLabel(opt.value, t),
                            }))}
                        />
                        {/* 类别预览 */}
                        <span
                            className={styles.categoryPreview}
                            style={{
                                color: CATEGORY_DISPLAY_MAP[category].color,
                                backgroundColor: CATEGORY_DISPLAY_MAP[category].bgColor,
                            }}
                        >
                            {getCategoryLabel(category, t)}
                        </span>
                    </div>

                    {/* 内容编辑 */}
                    <div className={styles.formGroup}>
                        <label className={styles.label}>{t('memory.factContent')}</label>
                        <textarea
                            className={styles.textarea}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder={t('memory.factPlaceholder')}
                            rows={4}
                        />
                    </div>

                    {/* 来源信息 */}
                    {sourceDescription && (
                        <div className={styles.formGroup}>
                            <label className={styles.label}>{t('memory.sourceInfo')}</label>
                            <div className={styles.sourceInfo}>
                                <span>{sourceDescription}</span>
                            </div>
                        </div>
                    )}

                    {/* 警告提示 */}
                    <div className={styles.warning}>
                        <CircleAlert size={16} strokeWidth={2.2} className={styles.warningIcon} />
                        <span>{isCreateMode ? t('memory.addWarning') : t('memory.editWarning')}</span>
                    </div>
                </div>

                {/* 底部按钮 */}
                <div className={styles.footer}>
                    <button
                        className={styles.cancelBtn}
                        onClick={onClose}
                        disabled={isSaving}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        className={styles.saveBtn}
                        onClick={handleSave}
                        disabled={isSaving || !content.trim()}
                    >
                        {isSaving
                            ? t('agent.settings.saving')
                            : isCreateMode
                              ? t('memory.saveFact')
                              : t('memory.saveChanges')}
                    </button>
                </div>
            </div>
        </div>
    );
}
