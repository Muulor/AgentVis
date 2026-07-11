/**
 * 网络直连授权弹窗
 *
 * 展示非 HTTP(S) direct-audit 目标，并由用户确认本次或本会话授权。
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useI18n, type TranslationKey } from '@/i18n';
import { useNetworkDirectAuthorizationStore } from '@stores/networkDirectAuthorizationStore';
import {
  classifyNetworkDirectTarget,
  hasMetadataNetworkDirectTarget,
  hasPrivateNetworkDirectTarget,
  type NetworkDirectTargetRisk,
} from '@utils/networkDirectRisk';
import styles from './NetworkDirectAuthorizationDialog.module.css';

const RISK_LABEL_KEYS: Record<NetworkDirectTargetRisk, TranslationKey> = {
  public: 'networkDirectAuth.risk.public',
  private: 'networkDirectAuth.risk.private',
  metadata: 'networkDirectAuth.risk.metadata',
  unknown: 'networkDirectAuth.risk.unknown',
};

function formatTarget(protocol: string, host: string, port: number): string {
  return `${protocol.toLowerCase()}://${host}:${port}`;
}

function truncateCommand(command: string): string {
  return command.length > 240 ? `${command.slice(0, 240)}...` : command;
}

function targetClassName(risk: NetworkDirectTargetRisk): string {
  return [
    styles.target,
    risk === 'private' ? styles.targetPrivate : '',
    risk === 'metadata' ? styles.targetMetadata : '',
    risk === 'unknown' ? styles.targetUnknown : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function formatResolvedIps(target: {
  resolvedIpSamples?: string[];
  resolvedRiskReason?: string;
}): string {
  const ips = target.resolvedIpSamples?.filter(Boolean) ?? [];
  const reason = target.resolvedRiskReason;
  if (ips.length === 0 && !reason) return '';
  if (ips.length > 0 && reason) return ` (${ips.join(', ')}; ${reason})`;
  if (ips.length > 0) return ` (${ips.join(', ')})`;
  return reason ? ` (${reason})` : '';
}

export function NetworkDirectAuthorizationDialog() {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const pending = useNetworkDirectAuthorizationStore((state) => state.pending);
  const approvePending = useNetworkDirectAuthorizationStore((state) => state.approvePending);
  const denyPending = useNetworkDirectAuthorizationStore((state) => state.denyPending);

  const request = pending?.request;
  const hasMetadataTarget = useMemo(
    () => Boolean(request && hasMetadataNetworkDirectTarget(request.targets)),
    [request]
  );
  const hasPrivateTarget = useMemo(
    () => Boolean(request && hasPrivateNetworkDirectTarget(request.targets)),
    [request]
  );

  return (
    <Dialog.Root open={Boolean(request)}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={contentRef}
          className={styles.content}
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter')
            ) {
              event.preventDefault();
            }
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <div className={styles.header}>
            <div className={styles.iconWrapper}>
              <ShieldAlert size={24} />
            </div>
            <Dialog.Title className={styles.title}>{t('networkDirectAuth.title')}</Dialog.Title>
          </div>

          {request && (
            <>
              <Dialog.Description className={styles.description}>
                {t('networkDirectAuth.description')}
              </Dialog.Description>

              {hasMetadataTarget && (
                <div className={styles.riskBanner}>{t('networkDirectAuth.metadataWarning')}</div>
              )}

              {!hasMetadataTarget && hasPrivateTarget && (
                <div className={styles.riskBanner}>{t('networkDirectAuth.privateWarning')}</div>
              )}

              <div className={styles.section}>
                <div className={styles.label}>{t('networkDirectAuth.targets')}</div>
                <div className={styles.targetList}>
                  {request.targets.map((target) => {
                    const risk = classifyNetworkDirectTarget(target);
                    return (
                      <code
                        key={`${target.protocol}:${target.host}:${target.port}`}
                        className={targetClassName(risk)}
                        title={t(RISK_LABEL_KEYS[risk])}
                      >
                        {formatTarget(target.protocol, target.host, target.port)}
                        {formatResolvedIps(target)}
                      </code>
                    );
                  })}
                </div>
              </div>

              <div className={styles.metaGrid}>
                <span>{t('networkDirectAuth.subject')}</span>
                <code>
                  {request.subjectId
                    ? `${request.subjectType}:${request.subjectId}`
                    : request.subjectType}
                </code>
                {request.workdir && (
                  <>
                    <span>{t('networkDirectAuth.workdir')}</span>
                    <code>{request.workdir}</code>
                  </>
                )}
              </div>

              <div className={styles.section}>
                <div className={styles.label}>{t('networkDirectAuth.command')}</div>
                <pre className={styles.command}>{truncateCommand(request.command)}</pre>
              </div>

              <div className={styles.actions}>
                <button type="button" className={styles.cancelButton} onClick={denyPending}>
                  {t('common.cancel')}
                </button>
                {!hasMetadataTarget && !hasPrivateTarget && (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => approvePending('session')}
                  >
                    {t('networkDirectAuth.allowSession')}
                  </button>
                )}
                {!hasMetadataTarget && (
                  <button
                    type="button"
                    className={styles.confirmButton}
                    onClick={() => approvePending('currentExecution')}
                  >
                    {t('networkDirectAuth.allowOnce')}
                  </button>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
