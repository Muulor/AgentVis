/**
 * ModeSelector - 模式选择器组件
 *
 * 功能：
 * - Chat / Task 模式切换（Task 继续使用内部值 planning）
 * - 下拉菜单形式
 */

import { useState, useCallback, useRef, useEffect, memo } from 'react';
import { useI18n, type TranslationKey } from '@/i18n';
import { Tooltip } from '@components/ui/Tooltip';
import type { ChatMode } from '@/types/chatMode';
import styles from './ModeSelector.module.css';

// ==================== 类型定义 ====================

interface ModeSelectorProps {
  /** 当前模式 */
  mode: ChatMode;
  /** 模式切换回调 */
  onChange: (mode: ChatMode) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 当前模型名称（用于检测图像生成模型并禁用 Task 模式） */
  modelName?: string;
}

// ==================== 模式配置 ====================

const MODE_CONFIG: Record<ChatMode, { labelKey: TranslationKey; descriptionKey: TranslationKey }> =
  {
    chat: {
      labelKey: 'chat.modeChatLabel',
      descriptionKey: 'chat.modeChatTitle',
    },
    planning: {
      labelKey: 'chat.modePlanningLabel',
      descriptionKey: 'chat.modePlanningTitle',
    },
  };

/**
 * 检测模型是否为图像生成模型（模型名含 image 关键字）
 * 图像生成模型仅支持 Chat 模式，Task 模式被禁用
 */
function isImageGenerationModel(modelName?: string): boolean {
  if (!modelName) return false;
  return modelName.toLowerCase().includes('image');
}

// ==================== 组件实现 ====================

/**
 * ModeSelector 模式选择器
 */
export const ModeSelector = memo(function ModeSelector({
  mode,
  onChange,
  disabled = false,
  modelName,
}: ModeSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 图像生成模型检测：强制 Chat 模式
  const isImageModel = isImageGenerationModel(modelName);
  const effectiveDisabled = disabled || isImageModel;

  useEffect(() => {
    if (isImageModel && mode !== 'chat') {
      onChange('chat');
    }
  }, [isImageModel, mode, onChange]);

  // 点击外部关闭
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    if (!effectiveDisabled) {
      setIsOpen((prev) => !prev);
    }
  }, [effectiveDisabled]);

  const handleSelect = useCallback(
    (newMode: ChatMode) => {
      onChange(newMode);
      setIsOpen(false);
    },
    [onChange]
  );

  const currentConfig = MODE_CONFIG[mode];
  const tooltipContent = isImageModel ? t('chat.imageModelChatOnly') : t('chat.selectMode');

  return (
    <div className={styles.container} ref={containerRef}>
      <Tooltip content={tooltipContent} disabled={disabled && !isImageModel}>
        <button
          className={styles.trigger}
          onClick={handleToggle}
          disabled={effectiveDisabled}
          data-mode={mode}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={t('chat.selectMode')}
        >
          <span className={styles.modeLabel}>{t(currentConfig.labelKey)}</span>
          <svg
            className={styles.arrow}
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            data-open={isOpen}
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>
      </Tooltip>

      {isOpen && (
        <div className={styles.dropdown} role="listbox">
          {(Object.entries(MODE_CONFIG) as [ChatMode, typeof MODE_CONFIG.chat][]).map(
            ([key, config]) => (
              <button
                key={key}
                className={styles.option}
                onClick={() => handleSelect(key)}
                role="option"
                aria-selected={mode === key}
                data-selected={mode === key}
              >
                <span className={styles.optionLabel}>{t(config.labelKey)}</span>
                <span className={styles.optionDescription}>{t(config.descriptionKey)}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
});
