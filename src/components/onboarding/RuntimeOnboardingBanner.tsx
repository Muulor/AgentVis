/**
 * RuntimeOnboardingBanner - 首次启动 Runtime 环境安装引导横幅
 *
 * 显示在 Shell 顶部（TopBar 下方），引导用户完成 Python 环境初始化。
 *
 * 三种显示状态：
 * 1. 初始态：提示用户安装环境，提供"开始安装"和"跳过"按钮
 * 2. 安装中：显示进度条和当前阶段描述
 * 3. 完成/错误：显示结果，自动消失或提供重试选项
 *
 * 生命周期：
 * - 仅在 envStatus 为 not_created / creating / installing_* / error 时显示
 * - ready 或 skipped 时隐藏
 * - 安装成功后短暂显示成功状态，然后自动消失
 */

import { useState, useCallback, useEffect } from 'react';
import { Zap, X, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { useRuntimeStore, useNeedsSetup, useIsInstalling } from '@stores/runtimeStore';
import { reconcileVenvState } from '@services/planning/skills/external/ExternalSkillBootstrap';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import { translateRuntimeProgressPhase } from '@/i18n/runtimeMessages';
import styles from './RuntimeOnboardingBanner.module.css';

// ==================== 常量 ====================

/** 安装成功后横幅自动消失延迟（毫秒） */
const SUCCESS_AUTO_DISMISS_MS = 3000;

// ==================== 组件 ====================

export function RuntimeOnboardingBanner() {
    const { t } = useI18n();
    const envStatus = useRuntimeStore((s) => s.envStatus);
    const installProgress = useRuntimeStore((s) => s.installProgress);
    const errorMessage = useRuntimeStore((s) => s.errorMessage);
    const needsSetup = useNeedsSetup();
    const isInstalling = useIsInstalling();

    const [isSettingUp, setIsSettingUp] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [showSuccess, setShowSuccess] = useState(false);

    // 挂载时协调持久化状态与物理状态
    // 防止持久化的中间状态（如 installing_base）导致 Banner 显示"正在安装"但无实际进程
    useEffect(() => {
        void reconcileVenvState();
    }, []);

    // 安装成功后自动消失
    useEffect(() => {
        if (envStatus === 'ready' && !dismissed) {
            setShowSuccess(true);
            const timer = setTimeout(() => {
                setDismissed(true);
                setShowSuccess(false);
            }, SUCCESS_AUTO_DISMISS_MS);
            return () => clearTimeout(timer);
        }
    }, [envStatus, dismissed]);

    // 新错误出现时重新显示横幅，避免用户关闭过初始提示后看不到失败原因。
    useEffect(() => {
        if (envStatus === 'error') {
            setDismissed(false);
            setShowSuccess(false);
        }
    }, [envStatus, errorMessage]);

    // 开始安装环境
    const handleSetup = useCallback(async () => {
        try {
            setIsSettingUp(true);
            // 使用共享安装流程，自动处理 requirements 文件写入 + venv 创建 + 基础包安装
            const { performEnvironmentSetup } = await import(
                '@services/planning/skills/external/requirementsProvider'
            );
            await performEnvironmentSetup();
        } catch (error) {
            const msg = error instanceof Error ? error.message
                : typeof error === 'string' ? error : t('onboarding.runtimeInstallError');
            useRuntimeStore.getState().setError(msg);
        } finally {
            setIsSettingUp(false);
        }
    }, [t]);

    // 跳过安装
    const handleSkip = useCallback(() => {
        useRuntimeStore.getState().markSkipped();
        setDismissed(true);
    }, []);

    // 关闭横幅
    const handleDismiss = useCallback(() => {
        setDismissed(true);
    }, []);

    // 重试（出错时）
    const handleRetry = useCallback(() => {
        useRuntimeStore.getState().clearError();
        useRuntimeStore.getState().setEnvStatus('not_created');
        void handleSetup();
    }, [handleSetup]);

    // ========== 渲染逻辑 ==========

    // 已隐藏/已就绪/已跳过 → 不渲染
    if (dismissed || envStatus === 'skipped') {
        return null;
    }

    // 成功状态（短暂显示）
    if (showSuccess) {
        return (
            <div className={cx(styles.banner, styles.successBanner)}>
                <div className={cx(styles.iconWrapper, styles.successIcon)}>
                    <CheckCircle size={16} />
                </div>
                <div className={styles.content}>
                    <p className={styles.title}>{t('onboarding.runtimeSuccessTitle')}</p>
                    <p className={styles.description}>{t('onboarding.runtimeSuccessDescription')}</p>
                </div>
                <button className={styles.closeButton} onClick={handleDismiss}>
                    <X size={14} />
                </button>
            </div>
        );
    }

    // 已就绪但不显示成功态 → 不渲染
    if (envStatus === 'ready' || envStatus === 'not_checked') {
        return null;
    }

    // 错误状态
    if (envStatus === 'error') {
        return (
            <div className={cx(styles.banner, styles.errorBanner)}>
                <div className={cx(styles.iconWrapper, styles.errorIcon)}>
                    <AlertTriangle size={16} />
                </div>
                <div className={styles.content}>
                    <p className={styles.title}>{t('onboarding.runtimeFailedTitle')}</p>
                    <p className={styles.description}>
                        {errorMessage ?? t('onboarding.runtimeUnknownError')}
                    </p>
                </div>
                <div className={styles.actions}>
                    <button className={styles.retryButton} onClick={handleRetry}>
                        <RefreshCw size={12} />
                        {t('common.retry')}
                    </button>
                    <button className={styles.skipButton} onClick={handleSkip}>
                        {t('onboarding.runtimeSkip')}
                    </button>
                    <button className={styles.closeButton} onClick={handleDismiss}>
                        <X size={14} />
                    </button>
                </div>
            </div>
        );
    }

    // 安装进行中
    if (isInstalling || isSettingUp) {
        return (
            <div className={styles.banner}>
                <div className={styles.iconWrapper}>
                    <span className={styles.spinner} />
                </div>
                <div className={styles.progressWrapper}>
                    <p className={styles.title}>{t('onboarding.runtimeInstalling')}</p>
                    {installProgress && (
                        <>
                            <div className={styles.progressBar}>
                                <div
                                    className={styles.progressFill}
                                    style={{ width: `${installProgress.percent}%` }}
                                />
                            </div>
                            <p className={styles.progressText}>
                                {translateRuntimeProgressPhase(installProgress.phase, t)}
                            </p>
                        </>
                    )}
                </div>
                <button className={styles.closeButton} onClick={handleDismiss}>
                    <X size={14} />
                </button>
            </div>
        );
    }

    // 初始态：提示用户安装
    if (needsSetup) {
        return (
            <div className={styles.banner}>
                <div className={styles.iconWrapper}>
                    <Zap size={16} />
                </div>
                <div className={styles.content}>
                    <p className={styles.title}>{t('onboarding.runtimeEnableTitle')}</p>
                    <p className={styles.description}>
                        {t('onboarding.runtimeEnableDescription')}
                    </p>
                </div>
                <div className={styles.actions}>
                    <button
                        className={styles.setupButton}
                        onClick={handleSetup}
                    >
                        <Zap size={12} />
                        {t('onboarding.runtimeStartInstall')}
                    </button>
                    <button className={styles.skipButton} onClick={handleSkip}>
                        {t('onboarding.runtimeLater')}
                    </button>
                </div>
            </div>
        );
    }

    return null;
}
