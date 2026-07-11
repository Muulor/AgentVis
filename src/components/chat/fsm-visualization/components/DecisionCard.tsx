/**
 * DecisionCard - 决策卡片组件
 *
 * 展示 MasterBrain 的决策结果
 *
 */

import { CheckCircle2, GitBranch, HelpCircle } from 'lucide-react';
import type { MasterBrainDecision } from '@/services/planning/brain/types';
import { useI18n } from '@/i18n';
import styles from './DecisionCard.module.css';

export interface DecisionCardProps {
  /** 决策对象 */
  decision: MasterBrainDecision;
}

/**
 * 决策类型配置
 */
interface DecisionConfig {
  icon: typeof CheckCircle2;
  getColorClass: () => string;
}

/**
 * 获取决策配置
 */
function getDecisionConfig(decisionType: MasterBrainDecision['decision']): DecisionConfig {
  const configs: Record<MasterBrainDecision['decision'], DecisionConfig> = {
    SPAWN_SUB_AGENT: {
      icon: GitBranch,
      getColorClass: () => styles.primary ?? '',
    },
    REQUEST_MORE_INPUT: {
      icon: HelpCircle,
      getColorClass: () => styles.warning ?? '',
    },
    RESPOND_TO_USER: {
      icon: CheckCircle2,
      getColorClass: () => styles.success ?? '',
    },
  };
  return configs[decisionType];
}

function getDecisionLabel(
  decisionType: MasterBrainDecision['decision'],
  t: ReturnType<typeof useI18n>['t']
) {
  switch (decisionType) {
    case 'SPAWN_SUB_AGENT':
      return t('chat.decisionSpawnSubAgent');
    case 'REQUEST_MORE_INPUT':
      return t('chat.decisionRequestMoreInput');
    case 'RESPOND_TO_USER':
      return t('chat.decisionRespondToUser');
  }
}

function getRiskLabel(riskLevel: 'low' | 'medium' | 'high', t: ReturnType<typeof useI18n>['t']) {
  switch (riskLevel) {
    case 'high':
      return t('chat.riskHigh');
    case 'medium':
      return t('chat.riskMedium');
    case 'low':
      return t('chat.riskLow');
  }
}

/**
 * 决策卡片组件
 */
export function DecisionCard({ decision }: DecisionCardProps) {
  const { t } = useI18n();
  const config = getDecisionConfig(decision.decision);
  const Icon = config.icon;
  const colorClass = config.getColorClass();

  // 根据风险等级获取颜色
  const riskLevel = decision.riskAssessment.level;
  const riskClass =
    riskLevel === 'high'
      ? (styles.riskHigh ?? '')
      : riskLevel === 'medium'
        ? (styles.riskMedium ?? '')
        : (styles.riskLow ?? '');

  return (
    <div className={`${styles.container ?? ''} ${colorClass}`}>
      {/* 头部 */}
      <div className={styles.header ?? ''}>
        <Icon size={18} className={styles.icon ?? ''} />
        <span className={styles.label ?? ''}>{getDecisionLabel(decision.decision, t)}</span>

        <span className={`${styles.riskBadge ?? ''} ${riskClass}`}>
          {t('chat.decisionRisk', { level: getRiskLabel(riskLevel, t) })}
        </span>
      </div>

      {/* 理由 */}
      {decision.rationale && <div className={styles.rationale ?? ''}>{decision.rationale}</div>}

      {/* 具体内容（根据决策类型） */}
      {decision.decision === 'SPAWN_SUB_AGENT' && decision.nextStep && (
        <div className={styles.details ?? ''}>
          <span className={styles.detailLabel ?? ''}>{t('chat.decisionSubAgent')}</span>
          <span className={styles.detailValue ?? ''}>
            {((decision.nextStep as Record<string, unknown>).task as string | undefined) ??
              t('chat.decisionTaskFallback')}
          </span>
        </div>
      )}

      {decision.decision === 'REQUEST_MORE_INPUT' && (
        <div className={styles.questions ?? ''}>
          <span className={styles.detailLabel ?? ''}>{t('chat.decisionQuestions')}</span>
          <ul className={styles.questionList ?? ''}>
            {decision.questionsForUser.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      {decision.decision === 'RESPOND_TO_USER' && decision.response && (
        <div className={styles.details ?? ''}>
          <span className={styles.detailLabel ?? ''}>{t('chat.decisionResponse')}</span>
          <span className={styles.detailValue ?? ''}>{decision.response}</span>
        </div>
      )}
    </div>
  );
}
