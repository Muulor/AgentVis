/**
 * StatusBar 底部状态栏
 *
 * 显示状态信息：
 * 1. 当前 Agent 使用的模型（无当前 Agent 时显示未配置）
 * 2. 前台 LLM 当前或最近一次调用的上下文用量（任务忙碌时）
 * 3. 记忆系统状态（水位线触发/整理状态）
 */

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from '@stores/agentStore';
import { useChatStore } from '@stores/chatStore';
import { useSettingsStore } from '@stores/settingsStore';
import { useStatusStore } from '@stores/statusStore';
import { useImChannelStore } from '@stores/imChannelStore';
import { getModelDisplayName, getProviderDisplayName } from '@/config/modelRegistry';
import { Tooltip } from '@components/ui/Tooltip';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';

import styles from './StatusBar.module.css';

/**
 * 格式化 token 数量显示
 * 例如：1500 -> "1.5k", 128000 -> "128k"
 */
function formatTokenCount(count: number): string {
  if (count >= 1000) {
    const k = count / 1000;
    // 如果是整数则不显示小数
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(count);
}

export function StatusBar() {
  const { t } = useI18n();
  // 获取当前 Agent
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const agents = useAgentStore((s) => s.agents);
  const currentAgent = agents.find((a) => a.id === currentAgentId);
  const activeTokenContextIdFromStore = useStatusStore((s) => s.activeTokenContextId);
  const activeTokenContextId = currentAgentId ?? activeTokenContextIdFromStore;

  // 获取默认设置
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);
  const defaultModel = useSettingsStore((s) => s.defaultModel);

  // 状态栏状态（双维度 Token：累积用量 + 实时压力）
  const modelStatus = useStatusStore((s) => s.modelStatus);
  const setModelStatus = useStatusStore((s) => s.setModelStatus);
  const memoryStatus = useStatusStore((s) => s.memoryStatus);
  const setMemoryStatus = useStatusStore((s) => s.setMemoryStatus);

  // 文档处理进度
  const documentProgress = useStatusStore((s) => s.documentProgress);

  // IM 通道连接状态（多 Bot 版本：统计在线 Bot 数量）
  const connectionStates = useImChannelStore((s) => s.connectionStates);
  const imConnectedCount = Object.values(connectionStates).filter((s) => s.isConnected).length;

  // 当前上下文正在进行或最近完成的调用用量
  const contextPressure = useStatusStore((s) => {
    return activeTokenContextId ? (s.contextPressureByAgent[activeTokenContextId] ?? null) : null;
  });
  const isActiveTokenContextBusy = useChatStore((s) =>
    activeTokenContextId
      ? s.sendingContexts.has(activeTokenContextId) ||
        (s.streamingByContext.get(activeTokenContextId)?.isStreaming ?? false)
      : false
  );
  const visibleContextPressure = isActiveTokenContextBusy ? contextPressure : null;
  const visibleContextTokens = visibleContextPressure
    ? visibleContextPressure.currentInputTokens + visibleContextPressure.currentOutputTokens
    : 0;
  const visibleContextRatio =
    visibleContextPressure && visibleContextPressure.contextWindowSize > 0
      ? visibleContextTokens / visibleContextPressure.contextWindowSize
      : 0;

  // 检查当前 Provider 的 API Key 配置状态
  const currentProvider = currentAgent?.modelProvider ?? (currentAgent ? defaultProvider : '');
  useEffect(() => {
    if (!currentProvider) {
      setModelStatus('unconfigured');
      return;
    }

    const checkApiKeyStatus = async () => {
      try {
        const status = await invoke<{ provider: string; configured: boolean }[]>(
          'settings_get_api_key_status'
        );
        const providerStatus = status.find((s) => s.provider === currentProvider);
        if (providerStatus?.configured) {
          // 已配置，设为绿灯（除非之前是 error 状态）
          const current = useStatusStore.getState().modelStatus;
          if (current !== 'error') {
            setModelStatus('online');
          }
        } else {
          setModelStatus('unconfigured');
        }
      } catch {
        // 检查失败，默认未配置
        setModelStatus('unconfigured');
      }
    };
    void checkApiKeyStatus();
  }, [currentProvider, setModelStatus]);

  // 监听水位线事件，更新记忆状态
  useEffect(() => {
    let unlistenTriggered: (() => void) | undefined;
    let unlistenCompleted: (() => void) | undefined;
    let unlistenFailed: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // 监听水位线触发事件
        unlistenTriggered = await listen('memory:watermark_triggered', () => {
          setMemoryStatus('organizing');
        });

        // 监听水位线完成事件
        unlistenCompleted = await listen('memory:watermark_completed', () => {
          setMemoryStatus('completed');
          // 3 秒后恢复就绪状态
          setTimeout(() => setMemoryStatus('idle'), 3000);
        });

        // 监听水位线失败事件
        unlistenFailed = await listen('memory:watermark_failed', () => {
          setMemoryStatus('idle');
        });
      } catch {
        // 事件监听设置失败不影响主流程
      }
    };

    void setupListeners();

    return () => {
      unlistenTriggered?.();
      unlistenCompleted?.();
      unlistenFailed?.();
    };
  }, [setMemoryStatus]);

  // 计算当前模型显示名称
  const modelProvider = currentAgent?.modelProvider ?? (currentAgent ? defaultProvider : '');
  const modelName = currentAgent?.modelName ?? (currentAgent ? defaultModel : '');
  const hasModelSelection = Boolean(modelProvider && modelName);
  const displayModelName = hasModelSelection
    ? getModelDisplayName(modelName)
    : t('agent.modelNotConfigured');
  const displayProviderName = hasModelSelection ? getProviderDisplayName(modelProvider) : '';
  const modelTitle = hasModelSelection
    ? `${displayProviderName} / ${modelName}`
    : t('agent.modelNotConfigured');

  // 第三类目：优先级 Planning > 文档处理 > 记忆状态
  const getThirdSectionContent = () => {
    // 1. 文档处理进度（高优先级）
    if (documentProgress?.isProcessing) {
      return (
        <div className={styles.memoryStatus}>
          <span className={styles.indicator} data-status="loading" />
          <span className={cx(styles.label, styles.labelHighlight)}>
            {documentProgress.message}
          </span>
        </div>
      );
    }

    // 3. 记忆状态（最低优先级）
    const memoryLabel =
      memoryStatus === 'organizing'
        ? t('layout.statusMemoryOrganizing')
        : memoryStatus === 'completed'
          ? t('layout.statusMemoryCompleted')
          : t('layout.statusReady');
    const isOrganizing = memoryStatus === 'organizing';

    return (
      <div className={styles.memoryStatus}>
        <span className={styles.indicator} data-status={isOrganizing ? 'loading' : 'online'} />
        <span className={cx(styles.label, isOrganizing && styles.labelHighlight)}>
          {memoryLabel}
        </span>
      </div>
    );
  };

  return (
    <footer className={styles.statusBar}>
      {/* 第一类目：模型状态 */}
      <Tooltip content={modelTitle}>
        <div className={styles.section}>
          <span className={styles.indicator} data-status={modelStatus} />
          <span className={styles.label}>{displayModelName}</span>
        </div>
      </Tooltip>

      <div className={styles.divider} />

      {/* 第二类目：当前或最近一次调用的上下文用量（仅任务忙碌时显示） */}
      {visibleContextPressure && (
        <>
          <Tooltip
            multiline
            content={t(
              visibleContextPressure.phase === 'active'
                ? 'layout.currentContextUsageTitle'
                : 'layout.lastContextUsageTitle',
              {
                input: visibleContextPressure.currentInputTokens,
                output: visibleContextPressure.currentOutputTokens,
                window: visibleContextPressure.contextWindowSize,
              }
            )}
          >
            <div className={styles.section}>
              <span
                className={styles.label}
                data-pressure={
                  visibleContextRatio > 0.95
                    ? 'critical'
                    : visibleContextRatio > 0.8
                      ? 'warning'
                      : 'normal'
                }
              >
                {t(
                  visibleContextPressure.phase === 'active'
                    ? 'layout.currentContextUsageLabel'
                    : 'layout.lastContextUsageLabel'
                )}
                : ≈ ↓ {formatTokenCount(visibleContextPressure.currentInputTokens)} + ↑{' '}
                {formatTokenCount(visibleContextPressure.currentOutputTokens)} /{' '}
                {formatTokenCount(visibleContextPressure.contextWindowSize)}
              </span>
            </div>
          </Tooltip>

          <div className={styles.divider} />
        </>
      )}

      {/* 第三类目：记忆/Planning 状态 */}
      <div className={styles.section}>{getThirdSectionContent()}</div>

      {/* IM 通道状态（多 Bot：显示在线数量） */}
      {imConnectedCount > 0 && (
        <>
          <div className={styles.divider} />
          <Tooltip content={t('layout.imConnectedTitle', { count: imConnectedCount })}>
            <div className={styles.section}>
              <span className={styles.indicator} data-status="online" />
              <span className={styles.label}>
                IM{imConnectedCount > 1 ? ` ×${imConnectedCount}` : ''}
              </span>
            </div>
          </Tooltip>
        </>
      )}

      {/* 右侧占位 */}
      <div className={styles.spacer} />

      {/* 版本号 */}
      <div className={styles.section}>
        <span className={styles.version}>v0.3.7</span>
      </div>
    </footer>
  );
}
