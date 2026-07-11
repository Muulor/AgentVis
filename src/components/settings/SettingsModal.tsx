/**
 * SettingsModal - 设置面板主组件
 *
 * 640px 宽度模态框，左侧导航标签 + 右侧设置内容分栏布局
 * 包含：常规、API 密钥、模型、云端服务、数据、技能、文件保护、安全审计、IM 通道。
 */

import { useState, useCallback, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderCog, FolderLock, MessagesSquare, ShieldCheck } from 'lucide-react';
import { GeneralSettings } from './GeneralSettings';
import { ApiKeySettings } from './ApiKeySettings';
import { ModelSettings } from './ModelSettings';
import { CloudServiceSettings } from './CloudServiceSettings';
import { DataSettings } from './DataSettings';
import { SkillSettings } from './SkillSettings';
import { FileProtectionSettings } from './FileProtectionSettings';
import { ImChannelSettings } from './ImChannelSettings';
import { SandboxAuditSettings } from './SandboxAuditSettings';
import { TextContextMenu, useTextContextMenu } from '@components/ui';
import { cx } from '@utils/classNames';
import { useRuntimeStore } from '@stores/runtimeStore';
import { useI18n, type TranslationKey } from '@/i18n';
import styles from './SettingsModal.module.css';

interface SettingsModalProps {
  /** 是否打开 */
  isOpen: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 打开时优先定位的标签页 */
  initialTab?: SettingsTab;
}

/** 设置标签页类型 */
export type SettingsTab =
  | 'general'
  | 'apiKeys'
  | 'model'
  | 'cloudService'
  | 'data'
  | 'skills'
  | 'fileProtection'
  | 'audit'
  | 'imChannel';

/** 标签页配置 */
const TABS: { id: SettingsTab; labelKey: TranslationKey; icon: React.ReactNode }[] = [
  {
    id: 'general',
    labelKey: 'settings.tabs.general',
    icon: <FolderCog size={16} strokeWidth={1.5} />,
  },
  {
    id: 'apiKeys',
    labelKey: 'settings.tabs.apiKeys',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M10.5 6.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z" />
        <path d="M9.5 9.5L14 14M12 12l2-2" />
      </svg>
    ),
  },
  {
    id: 'model',
    labelKey: 'settings.tabs.model',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="2" y="3" width="12" height="10" rx="1" />
        <path d="M5 7h6M5 10h4" />
      </svg>
    ),
  },
  {
    id: 'cloudService',
    labelKey: 'settings.tabs.cloudService',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M4 11a3 3 0 0 1-.5-5.95A4.5 4.5 0 0 1 12.08 6 3 3 0 0 1 12 12H4Z" />
      </svg>
    ),
  },
  {
    id: 'data',
    labelKey: 'settings.tabs.data',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <ellipse cx="8" cy="4" rx="5" ry="2" />
        <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
        <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
      </svg>
    ),
  },
  {
    id: 'skills',
    labelKey: 'settings.tabs.skills',
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <path d="M11.5 10v4M9.5 12h4" />
      </svg>
    ),
  },
  {
    id: 'fileProtection',
    labelKey: 'settings.tabs.fileProtection',
    icon: <FolderLock size={16} strokeWidth={1.5} />,
  },
  {
    id: 'audit',
    labelKey: 'settings.tabs.audit',
    icon: <ShieldCheck size={16} strokeWidth={1.5} />,
  },
  {
    id: 'imChannel',
    labelKey: 'settings.tabs.imChannel',
    icon: <MessagesSquare size={16} strokeWidth={1.5} />,
  },
];

export function SettingsModal({ isOpen, onClose, initialTab = 'general' }: SettingsModalProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const skillAuditStatus = useRuntimeStore((s) => s.skillAuditStatus);
  const skillAuditMinimized = useRuntimeStore((s) => s.skillAuditMinimized);
  const isSkillAuditModalActive = skillAuditStatus !== 'idle' && !skillAuditMinimized;
  const {
    menu: textContextMenu,
    closeMenu: closeTextContextMenu,
    openEditableMenu,
    handleMenuAction,
  } = useTextContextMenu();

  // ESC 键关闭
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  useEffect(() => {
    if (isOpen && skillAuditStatus !== 'idle') {
      setActiveTab('skills');
    }
  }, [isOpen, skillAuditStatus]);

  useEffect(() => {
    if (isOpen && skillAuditStatus === 'idle') {
      setActiveTab(initialTab);
    }
  }, [initialTab, isOpen, skillAuditStatus]);

  // 渲染当前标签页内容
  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return <GeneralSettings />;
      case 'apiKeys':
        return <ApiKeySettings />;
      case 'model':
        return <ModelSettings />;
      case 'cloudService':
        return <CloudServiceSettings />;
      case 'data':
        return <DataSettings />;
      case 'skills':
        return <SkillSettings />;
      case 'fileProtection':
        return <FileProtectionSettings />;
      case 'audit':
        return <SandboxAuditSettings />;
      case 'imChannel':
        return <ImChannelSettings />;
      default:
        return null;
    }
  };

  return (
    <Dialog.Root
      open={isOpen}
      modal={!isSkillAuditModalActive}
      onOpenChange={(open) => !open && onClose()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          aria-describedby={undefined}
          data-custom-context-menu
          onContextMenu={openEditableMenu}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          {/* 标题栏 */}
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>{t('settings.title')}</Dialog.Title>
            <Dialog.Close asChild>
              <button className={styles.closeButton} aria-label={t('common.close')}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {/* 主体区域：左侧导航 + 右侧内容 */}
          <div className={styles.body}>
            {/* 左侧导航 */}
            <nav className={styles.sidebar}>
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={cx(styles.tabButton, activeTab === tab.id && styles.tabButtonActive)}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className={styles.tabIcon}>{tab.icon}</span>
                  <span className={styles.tabLabel}>{t(tab.labelKey)}</span>
                </button>
              ))}
            </nav>

            {/* 右侧内容 */}
            <div className={styles.contentArea}>{renderTabContent()}</div>
          </div>
          <TextContextMenu
            menu={textContextMenu}
            onAction={handleMenuAction}
            onClose={closeTextContextMenu}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
