/**
 * AgentModelSelector - Agent 模型选择器下拉组件
 *
 * 在 Agent 名称下方显示当前模型，点击展开下拉菜单选择 Provider/Model
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { getProviders, getModelsByProvider, getModelDisplayName } from '@/config/modelRegistry';
import { Tooltip } from '@components/ui/Tooltip';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './AgentModelSelector.module.css';

interface AgentModelSelectorProps {
  provider: string | null;
  model: string | null;
  onSelect: (provider: string, model: string) => void;
}

export function AgentModelSelector({ provider, model, onSelect }: AgentModelSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setExpandedProvider(null);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // 获取当前显示的模型名称
  const getDisplayName = useCallback(() => {
    if (!model) return t('agent.modelNotConfigured');
    return getModelDisplayName(model);
  }, [model, t]);

  // 处理模型选择
  const handleModelSelect = (providerId: string, modelId: string) => {
    onSelect(providerId, modelId);
    setIsOpen(false);
    setExpandedProvider(null);
  };

  // 处理 Provider 点击（展开/收起子菜单）
  const handleProviderClick = (providerId: string) => {
    setExpandedProvider((prev) => (prev === providerId ? null : providerId));
  };

  return (
    <div className={styles.container} ref={containerRef}>
      {/* 触发器 */}
      <Tooltip content={t('agent.selectModel')}>
        <button
          className={styles.trigger}
          onClick={() => setIsOpen(!isOpen)}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={t('agent.selectModel')}
        >
          <span className={styles.modelName}>{getDisplayName()}</span>
          <svg
            className={cx(styles.chevron, isOpen && styles.chevronOpen)}
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>
      </Tooltip>

      {/* 下拉菜单 */}
      {isOpen && (
        <div className={styles.dropdown} role="listbox">
          {getProviders().map((p) => {
            const models = getModelsByProvider(p.id);
            const isExpanded = expandedProvider === p.id;
            const isCurrentProvider = provider === p.id;

            return (
              <div key={p.id} className={styles.providerGroup}>
                {/* Provider 标题 */}
                <button
                  className={cx(styles.providerHeader, isCurrentProvider && styles.providerActive)}
                  onClick={() => handleProviderClick(p.id)}
                >
                  <span>{p.name}</span>
                  <svg
                    className={cx(styles.expandIcon, isExpanded && styles.expandIconOpen)}
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M2.5 4l2.5 2.5 2.5-2.5" />
                  </svg>
                </button>

                {/* 模型列表 */}
                {isExpanded && (
                  <div className={styles.modelList}>
                    {models.map((m) => {
                      const isSelected = provider === p.id && model === m.id;
                      return (
                        <button
                          key={m.id}
                          className={cx(styles.modelOption, isSelected && styles.modelSelected)}
                          onClick={() => handleModelSelect(p.id, m.id)}
                          role="option"
                          aria-selected={isSelected}
                        >
                          {isSelected && (
                            <svg
                              className={styles.checkIcon}
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M2 6l3 3 5-5" />
                            </svg>
                          )}
                          <span>{m.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
