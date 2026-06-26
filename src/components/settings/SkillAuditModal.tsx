/**
 * SkillAuditModal - 技能包安全审查结果 Modal
 *
 * 展示审查进度和结果，提供用户决策按钮。
 * 4 种状态：auditing / approved|rejected|manual_review / error
 *
 * 设计原则：
 * - 从 runtimeStore 读取审查状态（单一数据源）
 * - 通过回调通知 SkillSettings 用户的决策
 * - 不直接操作安装/删除逻辑
 */

import React from 'react';
import {
    Search,
    ShieldCheck,
    ShieldX,
    AlertTriangle,
    AlertCircle,
    Minimize2,
} from 'lucide-react';
import { useRuntimeStore } from '@stores/runtimeStore';
import type { SkillAuditResult, SkillAuditFinding, FindingRiskLevel } from
    '@services/planning/skills/external/SkillAuditService';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './SkillAuditModal.module.css';

// ==================== 类型 ====================

/** 用户在 Modal 中的决策 */
export type AuditUserDecision = 'proceed' | 'remove' | 'cancel';

interface SkillAuditModalProps {
    /** 用户做出决策后的回调 */
    onDecision: (decision: AuditUserDecision) => void;
    /** 决策处理中（异步操作进行中），禁用所有决策按钮防重复点击 */
    isProcessing?: boolean;
}

// ==================== 辅助函数 ====================

/** 根据风险评分获取视觉等级 */
function getRiskTier(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score <= 3) return 'low';
    if (score <= 5) return 'medium';
    if (score <= 7) return 'high';
    return 'critical';
}

/** 获取状态图标（使用 lucide-react 保持应用风格统一） */
function getStatusIcon(status: string): React.ReactElement {
    const iconSize = 24;
    switch (status) {
        case 'preparing': return <Search size={iconSize} />;
        case 'auditing': return <Search size={iconSize} />;
        case 'approved': return <ShieldCheck size={iconSize} />;
        case 'rejected': return <ShieldX size={iconSize} />;
        case 'manual_review': return <AlertTriangle size={iconSize} />;
        case 'error': return <AlertCircle size={iconSize} />;
        default: return <Search size={iconSize} />;
    }
}

type TFunction = ReturnType<typeof useI18n>['t'];

/** 获取状态标题 */
function getStatusTitle(status: string, t: TFunction): string {
    switch (status) {
        case 'preparing': return t('settings.skills.auditStatusPreparing');
        case 'auditing': return t('settings.skills.auditStatusAuditing');
        case 'approved': return t('settings.skills.auditStatusApproved');
        case 'rejected': return t('settings.skills.auditStatusRejected');
        case 'manual_review': return t('settings.skills.auditStatusManualReview');
        case 'error': return t('settings.skills.auditStatusError');
        default: return t('settings.skills.auditStatusDefault');
    }
}

/** 获取状态 CSS class */
function getStatusClass(status: string): string {
    switch (status) {
        case 'approved': return styles.approved ?? '';
        case 'rejected': return styles.rejected ?? '';
        case 'manual_review': return styles.manualReview ?? '';
        case 'error': return styles.error ?? '';
        case 'preparing': return styles.auditing ?? '';
        default: return styles.auditing ?? '';
    }
}

// ==================== 子组件 ====================

/** 审查进度展示 */
function PreparingState(): React.ReactElement {
    const { t } = useI18n();

    return (
        <div className={styles.body}>
            <div className={styles.summary}>
                {t('settings.skills.auditPreparingPackage')}
            </div>
        </div>
    );
}

/** 审查进度展示 */
function AuditingState(): React.ReactElement {
    const { t } = useI18n();
    const progress = useRuntimeStore(s => s.skillAuditProgress);

    return (
        <div className={styles.body}>
            <div className={styles.summary}>
                {progress
                    ? t('settings.skills.auditScannedFiles', { count: progress.filesScanned, file: progress.currentFile })
                    : t('settings.skills.auditStarting')
                }
            </div>
        </div>
    );
}

/** 风险评分条 */
function RiskScoreBar({ result }: { result: SkillAuditResult }): React.ReactElement {
    const { t } = useI18n();
    const tier = getRiskTier(result.riskScore);
    const widthPercent = (result.riskScore / 10) * 100;

    return (
        <div className={styles.riskScoreBar}>
            <span className={styles.riskLabel}>{t('settings.skills.auditRiskScore')}</span>
            <div className={styles.riskScoreTrack}>
                <div
                    className={cx(styles.riskScoreFill, styles[tier])}
                    style={{ width: `${widthPercent}%` }}
                />
            </div>
            <span className={styles.riskValue}>{result.riskScore}/10</span>
        </div>
    );
}

/** 检测到的能力标签 */
function CapabilitiesTags({ capabilities }: { capabilities: string[] }): React.ReactElement | null {
    if (capabilities.length === 0) return null;

    return (
        <div className={styles.capabilities}>
            {capabilities.map((cap, i) => (
                <span key={i} className={styles.capabilityTag}>{cap}</span>
            ))}
        </div>
    );
}

/** 单个 Finding 条目 */
function FindingItem({ finding }: { finding: SkillAuditFinding }): React.ReactElement {
    const level = finding.riskLevel.toLowerCase() as Lowercase<FindingRiskLevel>;

    return (
        <div className={cx(styles.findingItem, styles[level])}>
            <div className={styles.findingMeta}>
                <span className={cx(styles.findingBadge, styles[level])}>
                    {finding.riskLevel}
                </span>
                <span className={styles.findingType}>{finding.riskType}</span>
                <span className={styles.findingFile}>{finding.file}</span>
            </div>
            <div className={styles.findingDesc}>{finding.description}</div>
        </div>
    );
}

/** Findings 列表 */
function FindingsList({ findings }: { findings: SkillAuditFinding[] }): React.ReactElement | null {
    const { t } = useI18n();
    if (findings.length === 0) return null;

    return (
        <>
            <div className={styles.findingsHeader}>
                {t('settings.skills.auditFindingsHeader', { count: findings.length })}
            </div>
            <div className={styles.findingsList}>
                {findings.map((finding, i) => (
                    <FindingItem key={i} finding={finding} />
                ))}
            </div>
        </>
    );
}

/** 审查结果内容区 */
function ResultContent({ result }: { result: SkillAuditResult }): React.ReactElement {
    return (
        <div className={styles.body}>
            <RiskScoreBar result={result} />
            <div className={styles.summary}>{result.summary}</div>
            <CapabilitiesTags capabilities={result.detectedCapabilities} />
            <FindingsList findings={result.findings} />
        </div>
    );
}

/** 错误状态内容 */
function ErrorContent({ error }: { error: string | null }): React.ReactElement {
    const { t } = useI18n();
    return (
        <div className={styles.body}>
            <div className={styles.summary}>
                {error ?? t('settings.skills.auditDefaultError')}
            </div>
        </div>
    );
}

// ==================== 底部按钮 ====================

/** 审查中 — 无操作按钮，等待完成 */
function AuditingFooter(): React.ReactElement {
    return <div className={styles.footer} />;
}

/** 通过 — 继续安装 or 取消安装 */
function ApprovedFooter({ onDecision, isProcessing }: { onDecision: (d: AuditUserDecision) => void; isProcessing?: boolean }): React.ReactElement {
    const { t } = useI18n();
    return (
        <div className={styles.footer}>
            <button
                className={cx(styles.btn, styles.btnSecondary)}
                onClick={() => onDecision('remove')}
                disabled={isProcessing}
            >
                {t('settings.skills.cancelInstall')}
            </button>
            <button
                className={cx(styles.btn, styles.btnSuccess)}
                onClick={() => onDecision('proceed')}
                disabled={isProcessing}
            >
                {isProcessing ? t('settings.skills.auditProcessing') : t('settings.skills.continueInstall')}
            </button>
        </div>
    );
}

/** 拒绝 — 移除 or 强制安装 */
function RejectedFooter({ onDecision, isProcessing }: { onDecision: (d: AuditUserDecision) => void; isProcessing?: boolean }): React.ReactElement {
    const { t } = useI18n();
    return (
        <div className={styles.footer}>
            <button
                className={cx(styles.btn, styles.btnDanger)}
                onClick={() => onDecision('remove')}
                disabled={isProcessing}
            >
                {t('settings.skills.removeSkillPackage')}
            </button>
            <button
                className={cx(styles.btn, styles.btnWarning)}
                onClick={() => onDecision('proceed')}
                disabled={isProcessing}
            >
                {isProcessing ? t('settings.skills.auditProcessing') : t('settings.skills.riskProceedInstall')}
            </button>
        </div>
    );
}

/** 需人工审查 — 移除 or 继续 */
function ManualReviewFooter({ onDecision, isProcessing }: { onDecision: (d: AuditUserDecision) => void; isProcessing?: boolean }): React.ReactElement {
    const { t } = useI18n();
    return (
        <div className={styles.footer}>
            <button
                className={cx(styles.btn, styles.btnSecondary)}
                onClick={() => onDecision('remove')}
                disabled={isProcessing}
            >
                {t('settings.skills.removeSkillPackage')}
            </button>
            <button
                className={cx(styles.btn, styles.btnPrimary)}
                onClick={() => onDecision('proceed')}
                disabled={isProcessing}
            >
                {isProcessing ? t('settings.skills.auditProcessing') : t('settings.skills.stillInstall')}
            </button>
        </div>
    );
}

/** 错误 — 跳过 or 取消 */
function ErrorFooter({ onDecision, isProcessing }: { onDecision: (d: AuditUserDecision) => void; isProcessing?: boolean }): React.ReactElement {
    const { t } = useI18n();
    return (
        <div className={styles.footer}>
            <button
                className={cx(styles.btn, styles.btnSecondary)}
                onClick={() => onDecision('cancel')}
                disabled={isProcessing}
            >
                {t('settings.skills.cancelInstall')}
            </button>
            <button
                className={cx(styles.btn, styles.btnWarning)}
                onClick={() => onDecision('proceed')}
                disabled={isProcessing}
            >
                {isProcessing ? t('settings.skills.auditProcessing') : t('settings.skills.skipAuditInstall')}
            </button>
        </div>
    );
}

// ==================== 主组件 ====================

/**
 * SkillAuditModal 主组件
 *
 * 从 runtimeStore 读取审查状态，根据状态渲染不同的 UI。
 * 用户决策通过 onDecision 回调通知父组件。
 */
export function SkillAuditModal({ onDecision, isProcessing }: SkillAuditModalProps): React.ReactElement | null {
    const { t } = useI18n();
    const auditStatus = useRuntimeStore(s => s.skillAuditStatus);
    const auditResult = useRuntimeStore(s => s.skillAuditResult);
    const auditError = useRuntimeStore(s => s.skillAuditError);
    const packagePath = useRuntimeStore(s => s.skillAuditPackagePath);
    const isMinimized = useRuntimeStore(s => s.skillAuditMinimized);
    const setSkillAuditMinimized = useRuntimeStore(s => s.setSkillAuditMinimized);

    // idle 状态不显示
    if (auditStatus === 'idle' || isMinimized) return null;

    // 从包路径提取技能名
    const skillName = packagePath?.split(/[\\/]/).pop() ?? t('settings.skills.skillPackageFallback');

    return (
        <div className={styles.overlay}>
            <div className={styles.modal}>
                {/* 顶部状态栏 */}
                <div className={styles.header}>
                    <div className={cx(styles.statusIcon, getStatusClass(auditStatus))}>
                        {getStatusIcon(auditStatus)}
                    </div>
                    <div className={styles.headerText}>
                        <h3 className={styles.title}>
                            {getStatusTitle(auditStatus, t)}
                        </h3>
                        <p className={styles.subtitle}>{skillName}</p>
                    </div>
                    <button
                        type="button"
                        className={styles.minimizeButton}
                        onClick={() => setSkillAuditMinimized(true)}
                        title={t('settings.skills.auditMinimize')}
                        aria-label={t('settings.skills.auditMinimize')}
                    >
                        <Minimize2 size={16} />
                    </button>
                </div>

                {/* 进度条（审查中显示） */}
                {(auditStatus === 'preparing' || auditStatus === 'auditing') && (
                    <div className={styles.progressBar}>
                        <div className={styles.progressFill} />
                    </div>
                )}

                {/* 内容区（根据状态渲染） */}
                {auditStatus === 'preparing' && <PreparingState />}
                {auditStatus === 'auditing' && <AuditingState />}
                {auditResult && auditStatus !== 'auditing' && auditStatus !== 'error' && (
                    <ResultContent result={auditResult} />
                )}
                {auditStatus === 'error' && <ErrorContent error={auditError} />}

                {/* 底部操作按钮 */}
                {auditStatus === 'preparing' && <AuditingFooter />}
                {auditStatus === 'auditing' && <AuditingFooter />}
                {auditStatus === 'approved' && <ApprovedFooter onDecision={onDecision} isProcessing={isProcessing} />}
                {auditStatus === 'rejected' && <RejectedFooter onDecision={onDecision} isProcessing={isProcessing} />}
                {auditStatus === 'manual_review' && <ManualReviewFooter onDecision={onDecision} isProcessing={isProcessing} />}
                {auditStatus === 'error' && <ErrorFooter onDecision={onDecision} isProcessing={isProcessing} />}
            </div>
        </div>
    );
}
