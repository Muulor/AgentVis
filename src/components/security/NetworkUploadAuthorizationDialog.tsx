/**
 * 网络上传确认弹窗
 *
 * 展示 ControlledNetwork 中高置信文件上传信号，并由用户确认本次执行。
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useNetworkUploadAuthorizationStore } from '@stores/networkUploadAuthorizationStore';
import type { NetworkRiskAuthorizationKind } from '@/types/networkUploadAuthorization';
import styles from './NetworkDirectAuthorizationDialog.module.css';

function truncateCommand(command: string): string {
  return command.length > 240 ? `${command.slice(0, 240)}...` : command;
}

function riskKindFromReason(reasonCode: string): NetworkRiskAuthorizationKind {
  if (reasonCode === 'network_sensitive_egress_confirmation_required') {
    return 'sensitiveEgress';
  }
  if (reasonCode === 'network_remote_destructive_confirmation_required') {
    return 'remoteDestructive';
  }
  return 'fileUpload';
}

export function NetworkUploadAuthorizationDialog() {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const pending = useNetworkUploadAuthorizationStore((state) => state.pending);
  const approvePending = useNetworkUploadAuthorizationStore((state) => state.approvePending);
  const denyPending = useNetworkUploadAuthorizationStore((state) => state.denyPending);

  const request = pending?.request;
  const riskKind = request
    ? (request.riskKind ?? riskKindFromReason(request.reasonCode))
    : 'fileUpload';

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
            <Dialog.Title className={styles.title}>
              {riskKind === 'sensitiveEgress'
                ? t('networkUploadAuth.sensitiveEgressTitle')
                : riskKind === 'remoteDestructive'
                  ? t('networkUploadAuth.remoteDestructiveTitle')
                  : t('networkUploadAuth.title')}
            </Dialog.Title>
          </div>

          {request && (
            <>
              <Dialog.Description className={styles.description}>
                {riskKind === 'sensitiveEgress'
                  ? t('networkUploadAuth.sensitiveEgressDescription')
                  : riskKind === 'remoteDestructive'
                    ? t('networkUploadAuth.remoteDestructiveDescription')
                    : t('networkUploadAuth.description')}
              </Dialog.Description>

              <div className={styles.riskBanner}>
                {riskKind === 'sensitiveEgress'
                  ? t('networkUploadAuth.sensitiveEgressWarning')
                  : riskKind === 'remoteDestructive'
                    ? t('networkUploadAuth.remoteDestructiveWarning')
                    : t('networkUploadAuth.warning')}
              </div>

              <div className={styles.metaGrid}>
                <span>{t('networkUploadAuth.subject')}</span>
                <code>
                  {request.subjectId
                    ? `${request.subjectType}:${request.subjectId}`
                    : request.subjectType}
                </code>
                {request.workdir && (
                  <>
                    <span>{t('networkUploadAuth.workdir')}</span>
                    <code>{request.workdir}</code>
                  </>
                )}
                <span>{t('networkUploadAuth.reason')}</span>
                <code>{request.reasonCode}</code>
              </div>

              <div className={styles.section}>
                <div className={styles.label}>{t('networkUploadAuth.command')}</div>
                <pre className={styles.command}>{truncateCommand(request.command)}</pre>
              </div>

              <div className={styles.actions}>
                <button type="button" className={styles.cancelButton} onClick={denyPending}>
                  {t('common.cancel')}
                </button>
                <button type="button" className={styles.confirmButton} onClick={approvePending}>
                  {t('networkUploadAuth.allowOnce')}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
