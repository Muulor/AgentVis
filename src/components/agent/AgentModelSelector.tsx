/**
 * AgentModelSelector - Agent 模型选择器下拉组件
 *
 * 在 Agent 名称下方显示当前模型，点击展开下拉菜单选择 Provider/Model
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  getProviders,
  getModelsByProvider,
  getModelDisplayName,
  getSupportedReasoningPresets,
  normalizeReasoningPreset,
  type ReasoningPreset,
} from '@/config/modelRegistry';
import { Tooltip } from '@components/ui/Tooltip';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import {
  hasConfigurableReasoningPresets,
  resolveModelSelectionPreset,
} from './AgentModelSelector.helpers';
import styles from './AgentModelSelector.module.css';

interface AgentModelSelectorProps {
  provider: string | null;
  model: string | null;
  reasoningPreset?: ReasoningPreset | null;
  onSelect: (provider: string, model: string, reasoningPreset: ReasoningPreset) => void;
}

interface ReasoningTarget {
  providerId: string;
  modelId: string;
  modelName: string;
}

export function AgentModelSelector({
  provider,
  model,
  reasoningPreset,
  onSelect,
}: AgentModelSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [reasoningTarget, setReasoningTarget] = useState<ReasoningTarget | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const reasoningPanelRef = useRef<HTMLDivElement>(null);
  const reasoningTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setExpandedProvider(null);
    setReasoningTarget(null);
    reasoningTriggerRef.current = null;
  }, []);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [closeMenu, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (reasoningTarget) {
        setReasoningTarget(null);
        reasoningTriggerRef.current?.focus();
      } else {
        closeMenu();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeMenu, isOpen, reasoningTarget]);

  useEffect(() => {
    if (!reasoningTarget) return;
    reasoningPanelRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus();
  }, [reasoningTarget]);

  // 获取当前显示的模型名称
  const getDisplayName = useCallback(() => {
    if (!model) return t('agent.modelNotConfigured');
    const displayName = getModelDisplayName(model);
    if (!provider) return displayName;
    return `${displayName} · ${normalizeReasoningPreset(provider, model, reasoningPreset)}`;
  }, [model, provider, reasoningPreset, t]);

  // 点击当前模型保留有效档位；切换到新路由时使用 recommended。
  const handleModelSelect = (providerId: string, modelId: string) => {
    onSelect(
      providerId,
      modelId,
      resolveModelSelectionPreset(provider, model, reasoningPreset, providerId, modelId)
    );
    closeMenu();
  };

  // 处理 Provider 点击（展开/收起子菜单）
  const handleProviderClick = (providerId: string) => {
    setExpandedProvider((prev) => (prev === providerId ? null : providerId));
    setReasoningTarget(null);
  };

  const handleTriggerClick = () => {
    if (isOpen) {
      closeMenu();
      return;
    }
    setIsOpen(true);
    setExpandedProvider(provider);
  };

  const openReasoningMenu = (target: ReasoningTarget, trigger: HTMLButtonElement) => {
    reasoningTriggerRef.current = trigger;
    setReasoningTarget(target);
  };

  const handleReasoningSelect = (preset: ReasoningPreset) => {
    if (!reasoningTarget) return;
    onSelect(reasoningTarget.providerId, reasoningTarget.modelId, preset);
    closeMenu();
  };

  const reasoningOptions = reasoningTarget
    ? getSupportedReasoningPresets(reasoningTarget.providerId, reasoningTarget.modelId)
    : [];

  return (
    <div className={styles.container} ref={containerRef}>
      {/* 触发器 */}
      <Tooltip content={t('agent.selectModel')}>
        <button
          className={styles.trigger}
          onClick={handleTriggerClick}
          aria-haspopup="menu"
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
        <div className={styles.dropdown}>
          <div className={styles.providerMenu} role="menu" aria-label={t('agent.selectModel')}>
            {getProviders().map((p) => {
              const models = getModelsByProvider(p.id);
              const isExpanded = expandedProvider === p.id;
              const isCurrentProvider = provider === p.id;

              return (
                <div key={p.id} className={styles.providerGroup}>
                  {/* Provider 标题 */}
                  <button
                    className={cx(
                      styles.providerHeader,
                      isCurrentProvider && styles.providerActive
                    )}
                    onClick={() => handleProviderClick(p.id)}
                    aria-expanded={isExpanded}
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
                        const hasReasoningMenu = hasConfigurableReasoningPresets(p.id, m.id);
                        const isReasoningOpen =
                          reasoningTarget?.providerId === p.id && reasoningTarget.modelId === m.id;
                        const selectedPreset = isSelected
                          ? normalizeReasoningPreset(p.id, m.id, reasoningPreset)
                          : 'recommended';

                        return (
                          <div
                            key={m.id}
                            className={cx(styles.modelRow, isSelected && styles.modelSelected)}
                          >
                            <button
                              className={styles.modelOption}
                              onClick={() => handleModelSelect(p.id, m.id)}
                              role="menuitemradio"
                              aria-checked={isSelected}
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
                              <span className={styles.modelOptionName}>{m.name}</span>
                              {isSelected && !hasReasoningMenu && (
                                <span className={styles.currentPreset}>{selectedPreset}</span>
                              )}
                            </button>
                            {hasReasoningMenu && (
                              <button
                                className={cx(
                                  styles.reasoningButton,
                                  isReasoningOpen && styles.reasoningButtonOpen
                                )}
                                onClick={(event) =>
                                  openReasoningMenu(
                                    {
                                      providerId: p.id,
                                      modelId: m.id,
                                      modelName: m.name,
                                    },
                                    event.currentTarget
                                  )
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'ArrowRight') {
                                    event.preventDefault();
                                    openReasoningMenu(
                                      {
                                        providerId: p.id,
                                        modelId: m.id,
                                        modelName: m.name,
                                      },
                                      event.currentTarget
                                    );
                                  }
                                }}
                                aria-haspopup="menu"
                                aria-expanded={isReasoningOpen}
                                aria-label={t('agent.selectReasoningEffortFor', {
                                  model: m.name,
                                })}
                              >
                                <span>{isSelected ? selectedPreset : 'recommended'}</span>
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  aria-hidden="true"
                                >
                                  <path d="M4 2.5L6.5 5 4 7.5" />
                                </svg>
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {reasoningTarget && (
            <div
              className={styles.reasoningPanel}
              ref={reasoningPanelRef}
              role="menu"
              aria-label={t('agent.reasoningEffortFor', { model: reasoningTarget.modelName })}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft') return;
                event.preventDefault();
                setReasoningTarget(null);
                reasoningTriggerRef.current?.focus();
              }}
            >
              <div className={styles.reasoningPanelHeader}>
                <span>{t('agent.reasoningEffort')}</span>
                <strong>{reasoningTarget.modelName}</strong>
                <p>{t('agent.reasoningEffortHint')}</p>
              </div>
              <div className={styles.reasoningOptions}>
                {reasoningOptions.map((preset) => {
                  const isSelected =
                    provider === reasoningTarget.providerId && model === reasoningTarget.modelId
                      ? normalizeReasoningPreset(provider, model, reasoningPreset) === preset
                      : preset === 'recommended';
                  return (
                    <button
                      key={preset}
                      className={cx(
                        styles.reasoningOption,
                        isSelected && styles.reasoningOptionSelected
                      )}
                      onClick={() => handleReasoningSelect(preset)}
                      role="menuitemradio"
                      aria-checked={isSelected}
                    >
                      <span className={styles.reasoningCheck} aria-hidden="true">
                        {isSelected ? '✓' : ''}
                      </span>
                      <span>{preset}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
