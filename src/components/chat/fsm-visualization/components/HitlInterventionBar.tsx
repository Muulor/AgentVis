/**
 * HitlInterventionBar - Human-in-the-Loop 暂停介入条
 *
 * 嵌入在 SubAgentObservationSection 底部。
 *
 * SA 运行中：显示轻量「⏸」暂停图标按钮
 * SA 暂停后（等待用户输入）：展开为介入操作区，包含文本输入框和操作按钮
 * SA 暂停后（指令已发送，等待工具完成）：展示"等待工具完成"的只读提示状态
 *
 * 用户可选择：
 * A) 直接继续（无介入消息）
 * B) 输入消息后发送并继续（消息注入 additionalInstructions）
 * 如需终止任务，使用底部输入框右侧的常规停止按钮即可。
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, MessageSquare, Pause, Clock } from 'lucide-react';
import { useHitlStore } from '@stores/hitlStore';
import { useI18n } from '@/i18n';
import { Tooltip } from '@components/ui/Tooltip';
import { cx } from '@utils/classNames';
import { getElapsedExecTimeoutSeconds } from '@/services/planning/utils/ExecTimeoutObservation';
import styles from './HitlInterventionBar.module.css';

// ============================================================================
// 类型定义
// ============================================================================

interface HitlInterventionBarProps {
  /** 关联的 Agent 上下文 ID */
  contextId: string;
  /** SA 是否正在运行（仅运行中才展示暂停按钮） */
  isRunning: boolean;
  /** 当前 pending exec 的显式 timeout 秒数；默认 timeout 不展示 */
  execTimeoutSeconds?: number;
  /** 当前 pending exec 的开始时间戳 */
  execTimeoutStartedAtMs?: number;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * Human-in-the-Loop 介入操作条
 *
 * 设计原则：
 * - 未暂停时仅显示轻量暂停按钮，不干扰主界面
 * - 暂停后（等待用户决策）展开为完整操作区
 * - 用户已发送指令但 SA 仍阻塞在工具调用中时，切换为等待提示状态，
 *   避免用户因 UI 无变化而误以为操作无效并反复点击（覆盖原指令）
 */
export function HitlInterventionBar({
  contextId,
  isRunning,
  execTimeoutSeconds,
  execTimeoutStartedAtMs,
}: HitlInterventionBarProps) {
  const { t } = useI18n();
  // 直接订阅两个 Zustand state Set，使依赖关系明确：
  // - pausedContexts: SA 已收到暂停请求，等待用户决策（waitForResume 阻塞中）
  // - preResolvedContexts: 用户已发送恢复指令，但 SA 仍阻塞在工具 HTTP 调用中
  //   waitForResume 尚未被注册，SA 未读取到该指令
  const isNormalPaused = useHitlStore((s) => s.pausedContexts.has(contextId));
  const isPreResolved = useHitlStore((s) => s.preResolvedContexts.has(contextId));
  const isPaused = isNormalPaused || isPreResolved;

  const pause = useHitlStore((s) => s.pause);
  const resume = useHitlStore((s) => s.resume);

  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasExecTimeoutStatus =
    execTimeoutSeconds !== undefined && execTimeoutStartedAtMs !== undefined;

  useEffect(() => {
    if (!isRunning || isPaused || !hasExecTimeoutStatus) {
      return undefined;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [hasExecTimeoutStatus, isPaused, isRunning, execTimeoutSeconds, execTimeoutStartedAtMs]);

  // 暂停展开后自动聚焦输入框（仅在等待用户决策阶段，不在预解决等待阶段）
  useEffect(() => {
    if (isNormalPaused && !isPreResolved && inputRef.current) {
      // 延迟一帧，等待 CSS 过渡完成后再聚焦
      const timer = setTimeout(() => inputRef.current?.focus(), 150);
      return () => clearTimeout(timer);
    }
  }, [isNormalPaused, isPreResolved]);

  // 处理暂停按钮点击
  const handlePause = useCallback(() => {
    pause(contextId);
  }, [contextId, pause]);

  // 直接继续（无介入消息）
  const handleResumeOnly = useCallback(() => {
    setInputValue('');
    resume(contextId, undefined);
  }, [contextId, resume]);

  // 发送介入消息并继续
  const handleSendAndResume = useCallback(() => {
    const message = inputValue.trim();
    if (!message) return;
    setInputValue('');
    resume(contextId, message);
  }, [contextId, inputValue, resume]);

  // 输入框 Enter 提交，Shift+Enter 换行
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (inputValue.trim()) {
          handleSendAndResume();
        } else {
          handleResumeOnly();
        }
      }
    },
    [inputValue, handleSendAndResume, handleResumeOnly]
  );

  // SA 未运行时不渲染（避免任务完成后残留控件）
  if (!isRunning && !isPaused) {
    return null;
  }

  const elapsedExecTimeoutSeconds = hasExecTimeoutStatus
    ? getElapsedExecTimeoutSeconds(execTimeoutStartedAtMs, nowMs, execTimeoutSeconds)
    : undefined;

  return (
    <div className={styles.container}>
      {/* ─── SA 运行中：轻量暂停按钮 ─── */}
      {isRunning && !isPaused && (
        <div className={cx(styles.runningBar, hasExecTimeoutStatus && styles.runningBarWithHint)}>
          {hasExecTimeoutStatus && elapsedExecTimeoutSeconds !== undefined && (
            <div className={styles.timeoutHint}>
              <Clock size={12} className={styles.timeoutIcon} />
              <span className={styles.timeoutText}>
                {t('chat.execTimeoutLimit', {
                  elapsed: elapsedExecTimeoutSeconds,
                  timeout: execTimeoutSeconds,
                })}
              </span>
            </div>
          )}
          <Tooltip content={t('chat.hitlPauseTitle')}>
            <button
              className={styles.pauseBtn}
              onClick={handlePause}
              aria-label={t('chat.hitlPauseAria')}
            >
              <Pause size={12} />
              <span>{t('chat.hitlPause')}</span>
            </button>
          </Tooltip>
        </div>
      )}

      {/* ─── 已发送指令，等待工具调用完成 ─── */}
      {/* SA 阻塞在 HTTP 调用（如 generate_image 180s 超时），
                用户的恢复指令已暂存在 preResolvedMap，
                待 SA 工具调用完成后会在下一个步间检查点自动消费。
                此时禁用输入区，避免用户因无反馈反复操作覆盖原有指令。 */}
      {isPreResolved && (
        <div className={styles.pendingBar}>
          <Clock size={12} className={styles.pendingIcon} />
          <div className={styles.pendingText}>
            <span className={styles.pendingTitle}>{t('chat.hitlPendingTitle')}</span>
            <span className={styles.pendingSubtext}>{t('chat.hitlPendingSubtext')}</span>
          </div>
        </div>
      )}

      {/* ─── SA 已暂停（等待用户决策）：展开介入操作区 ─── */}
      {isNormalPaused && !isPreResolved && (
        <div className={styles.pausedBar}>
          {/* 状态提示 */}
          <div className={styles.pauseHint}>
            <span className={styles.pauseIndicator} />
            {t('chat.hitlPausedHint')}
          </div>

          {/* 介入消息输入框 */}
          <textarea
            ref={inputRef}
            className={styles.interventionInput}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('chat.hitlPlaceholder')}
            rows={2}
            aria-label={t('chat.hitlInputAria')}
          />

          {/* 操作按钮组 */}
          <div className={styles.actionRow}>
            {/* 右侧：继续 / 发送并继续 */}
            <div className={styles.resumeGroup}>
              <Tooltip content={t('chat.hitlResumeTitle')}>
                <button
                  className={styles.resumeBtn}
                  onClick={handleResumeOnly}
                  aria-label={t('chat.hitlResume')}
                >
                  <Play size={11} />
                  <span>{t('chat.hitlResume')}</span>
                </button>
              </Tooltip>
              {inputValue.trim() && (
                <Tooltip content={t('chat.hitlSendResumeTitle')}>
                  <button
                    className={styles.sendResumeBtn}
                    onClick={handleSendAndResume}
                    aria-label={t('chat.hitlSendResume')}
                  >
                    <MessageSquare size={11} />
                    <span>{t('chat.hitlSendResume')}</span>
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
