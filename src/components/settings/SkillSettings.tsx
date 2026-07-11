/**
 * SkillSettings - 技能管理标签页
 *
 * 三个区域：
 * 1. 已安装技能列表（状态图标 + 依赖提示）
 * 2. 安装新技能（导入文件夹 / GitHub URL 安装）
 * 3. Python 环境状态（版本 / 状态 / 重建按钮）
 *
 * 设计原则：
 * - Figma 风格，使用 lucide-react 图标
 * - 复用 runtimeStore 驱动状态
 * - 错误提示友好，操作可重试
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { useToast } from '@components/ui/Toast';
import { Tooltip } from '@components/ui/Tooltip';
import { invoke } from '@tauri-apps/api/core';
import {
  FolderInput,
  FolderOpen,
  Download,
  CheckCircle,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldX,
  Trash2,
  Zap,
  Copy,
  Package,
  Terminal,
  Loader2,
  RotateCw,
  ChevronDown,
  ChevronRight,
  Power,
} from 'lucide-react';
import { useRuntimeStore, useInstalledSkills, useIsInstalling } from '@stores/runtimeStore';
import type { SkillAuditStatus, ToolInstallEntry } from '@stores/runtimeStore';
import {
  copySkillPackageToPackagesDir,
  removeSkillPackage,
  rescanExternalSkills,
  reconcileVenvState,
  uninstallSkill,
} from '@services/planning/skills/external/ExternalSkillBootstrap';
import {
  auditSkillPackage,
  collectPackageFiles,
} from '@services/planning/skills/external/SkillAuditService';
import { SkillAuditModal } from './SkillAuditModal';
import type { AuditUserDecision } from './SkillAuditModal';
import {
  installNpmPackage,
  installSystemTool,
  installCargoPackage,
  installGoPackage,
  isCommandAvailableWithFreshPath,
  isNpmPackageInstalled,
  isCargoPackageInstalled,
  isGoPackageInstalled,
  isNetworkRelatedError,
  isChromeForTestingInstallFailure,
} from '@services/planning/skills/external/DependencyInstaller';
import { createTauriShellExecute } from '@services/planning/skills/external/tauriShellAdapter';
import type { SystemToolInfo } from '@services/planning/skills/external/DependencyAnalyzer';
import styles from './SkillSettings.module.css';
import { getLogger } from '@services/logger';
import { openExternalUrl } from '@services/navigation/externalUrl';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import {
  translateDependencyInstallResultMessage,
  translateRuntimeProgressPhase,
} from '@/i18n/runtimeMessages';

const logger = getLogger('SkillSettings');

// ==================== 类型 ====================

/** GitHub 安装结果消息 */
interface ResultMessage {
  type: 'success' | 'error';
  text: string;
}

interface PendingSkillInstall {
  destPath: string;
  skillName: string;
  source: 'local' | 'github';
}

function getErrorMessage(error: unknown, fallback: string): string {
  let message = '';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    try {
      const serialized = JSON.stringify(error);
      message = typeof serialized === 'string' ? serialized : '';
    } catch {
      message = '';
    }
  }
  return message.trim() || fallback;
}

type TFunction = ReturnType<typeof useI18n>['t'];

function translateSkillInstallError(rawMessage: string, t: TFunction): string {
  if (rawMessage.includes('SKILL_INSTALL_INVALID:missing-root-skill-md')) {
    return t('settings.skills.githubInvalidMissingSkillMd');
  }
  if (rawMessage.includes('SKILL_INSTALL_INVALID:missing-frontmatter-name')) {
    return t('settings.skills.githubInvalidMissingName');
  }
  if (rawMessage.includes('SKILL_INSTALL_INVALID:missing-frontmatter-description')) {
    return t('settings.skills.githubInvalidMissingDescription');
  }

  const duplicateMatch = rawMessage.match(/Skill package '([^']+)' already exists/i);
  if (duplicateMatch?.[1]) {
    return t('settings.skills.githubPackageAlreadyExists', { name: duplicateMatch[1] });
  }

  return rawMessage;
}

function formatPostInstallFailureMessage(
  command: string,
  output: string,
  isNetworkError: boolean,
  t: TFunction
): string {
  if (isChromeForTestingInstallFailure(command, output)) {
    return t('settings.skills.chromeForTestingInstallNetworkHint');
  }

  if (isNetworkError) {
    return `${t('settings.skills.operationFailed')}: ${t('settings.skills.networkError')}`;
  }

  const detail = output.trim().slice(0, 200);
  return `${t('settings.skills.operationFailed')}: ${detail || t('settings.skills.unknownError')}`;
}

function getDependencyActionTitle(
  isChecking: boolean,
  isInstalling: boolean,
  isInstalled: boolean,
  isError: boolean,
  t: TFunction
): string {
  if (isChecking) return t('settings.skills.checkingDependencyTitle');
  if (isInstalling) return t('settings.skills.installingDependencyTitle');
  if (isInstalled) return t('settings.skills.dependencyInstalledTitle');
  if (isError) return t('settings.skills.retryInstallTitle');
  return t('settings.skills.installDependencyTitle');
}

function getPostInstallActionTitle(
  isChecking: boolean,
  isInstalling: boolean,
  isInstalled: boolean,
  isError: boolean,
  t: TFunction
): string {
  if (isChecking) return t('settings.skills.checkingCommandTitle');
  if (isInstalling) return t('settings.skills.executingCommandTitle');
  if (isInstalled) return t('settings.skills.postInstallCompletedTitle');
  if (isError) return t('settings.skills.retryCommandTitle');
  return t('settings.skills.executeCommandTitle');
}

async function createPackageListFiles() {
  const { readDir } = await import('@tauri-apps/plugin-fs');
  return async (dir: string) => {
    const entries = await readDir(dir);
    return entries.map((e) => e.name).filter((n): n is string => !!n);
  };
}

function getAuditSkillName(packagePath: string | null, fallback: string): string {
  return packagePath?.split(/[\\/]/).pop() ?? fallback;
}

function isAuditFinished(status: SkillAuditStatus): boolean {
  return (
    status === 'approved' ||
    status === 'rejected' ||
    status === 'manual_review' ||
    status === 'error'
  );
}

function getAuditBannerTone(status: SkillAuditStatus): 'active' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'approved':
      return 'success';
    case 'rejected':
      return 'danger';
    case 'manual_review':
    case 'error':
      return 'warning';
    default:
      return 'active';
  }
}

function getAuditBannerIcon(status: SkillAuditStatus): ReactNode {
  const iconSize = 16;
  switch (status) {
    case 'approved':
      return <ShieldCheck size={iconSize} />;
    case 'rejected':
      return <ShieldX size={iconSize} />;
    case 'manual_review':
    case 'error':
      return <AlertTriangle size={iconSize} />;
    default:
      return <Search size={iconSize} />;
  }
}

function getAuditBannerTitle(status: SkillAuditStatus, t: TFunction): string {
  switch (status) {
    case 'preparing':
      return t('settings.skills.auditBannerPreparing');
    case 'auditing':
      return t('settings.skills.auditBannerAuditing');
    case 'approved':
      return t('settings.skills.auditBannerApproved');
    case 'rejected':
      return t('settings.skills.auditBannerRejected');
    case 'manual_review':
      return t('settings.skills.auditBannerManualReview');
    case 'error':
      return t('settings.skills.auditBannerError');
    default:
      return t('settings.skills.auditStatusDefault');
  }
}

function getAuditBannerDetail(
  status: SkillAuditStatus,
  progress: { filesScanned: number; currentFile: string } | null,
  t: TFunction
): string {
  if (status === 'auditing' && progress) {
    return t('settings.skills.auditBannerScannedFiles', { count: progress.filesScanned });
  }

  if (status === 'preparing' || status === 'auditing') {
    return t('settings.skills.auditBannerInProgress');
  }

  if (status === 'error') {
    return t('settings.skills.auditBannerErrorDetail');
  }

  return t('settings.skills.auditBannerAwaitingDecision');
}

// ==================== 子组件 ====================

function SkillAuditStatusBanner() {
  const { t } = useI18n();
  const auditStatus = useRuntimeStore((s) => s.skillAuditStatus);
  const isMinimized = useRuntimeStore((s) => s.skillAuditMinimized);
  const packagePath = useRuntimeStore((s) => s.skillAuditPackagePath);
  const progress = useRuntimeStore((s) => s.skillAuditProgress);
  const setSkillAuditMinimized = useRuntimeStore((s) => s.setSkillAuditMinimized);

  if (auditStatus === 'idle' || !isMinimized) return null;

  const skillName = getAuditSkillName(packagePath, t('settings.skills.skillPackageFallback'));
  const tone = getAuditBannerTone(auditStatus);
  const toneClass = {
    active: styles.auditBannerActive,
    success: styles.auditBannerSuccess,
    warning: styles.auditBannerWarning,
    danger: styles.auditBannerDanger,
  }[tone];
  const actionText = isAuditFinished(auditStatus)
    ? t('settings.skills.auditBannerViewResult')
    : t('settings.skills.auditBannerViewProgress');

  return (
    <div className={cx(styles.auditBanner, toneClass)}>
      <div className={styles.auditBannerIcon}>{getAuditBannerIcon(auditStatus)}</div>
      <div className={styles.auditBannerText}>
        <div className={styles.auditBannerTitleRow}>
          <span className={styles.auditBannerTitle}>{getAuditBannerTitle(auditStatus, t)}</span>
          <span className={styles.auditBannerSkill}>{skillName}</span>
        </div>
        <div className={styles.auditBannerDetail}>
          {getAuditBannerDetail(auditStatus, progress, t)}
        </div>
      </div>
      <button
        type="button"
        className={styles.auditBannerButton}
        onClick={() => setSkillAuditMinimized(false)}
      >
        {actionText}
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

/**
 * 依赖安装错误消息渲染
 *
 * 支持换行（\n）和可点击的 URL（通过系统浏览器打开）。
 * 用于 systemTools 安装失败时展示 fallbackUrl 下载链接。
 */
function DepErrorMessage({ message }: { message: string }) {
  // split 用带捕获组的正则保留 URL 作为分割结果的一部分
  const URL_SPLIT = /(https?:\/\/[^\s]+)/g;
  // test 用不带 g flag 的正则避免 lastIndex 状态问题
  const URL_TEST = /^https?:\/\//;

  const handleLinkClick = async (url: string) => {
    const opened = await openExternalUrl(url);
    if (!opened) {
      void navigator.clipboard.writeText(url);
    }
  };

  // 按换行分割，每行内再识别 URL
  const lines = message.split('\n');
  return (
    <>
      {lines.map((line, lineIdx) => (
        <span key={lineIdx}>
          {lineIdx > 0 && <br />}
          {line.split(URL_SPLIT).map((part, partIdx) =>
            URL_TEST.test(part) ? (
              <a
                key={partIdx}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void handleLinkClick(part);
                }}
                style={{
                  color: 'var(--accent-color, #4fc3f7)',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                }}
              >
                {part}
              </a>
            ) : (
              <span key={partIdx}>{part}</span>
            )
          )}
        </span>
      ))}
    </>
  );
}

/**
 * 复制文本到剪贴板
 *
 * 成功时短暂替换按钮文本为「已复制」提示
 */
function useCopyToClipboard() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // 剪贴板不可用时静默失败
    }
  }, []);

  return { copiedKey, copyText };
}

/**
 * 检测当前操作系统平台
 *
 * 用于选择系统工具的平台对应安装指令
 */
function detectPlatform(): 'windows' | 'mac' | 'linux' {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'mac';
  return 'linux';
}

/**
 * 一键安装 hook
 *
 * 封装安装流程：更新 Store 状态 → 调用 DependencyInstaller → 更新结果
 * 支持重试（网络错误时显示重试按钮）
 */
/**
 * 生成工具安装状态的 store key
 *
 * 使用 packageName 作为 key（而非 command），确保：
 * 1. 跨 Skill 的同名工具（如 docx 和 pdf 都需要 Poppler）共享安装状态
 * 2. detectCommand 与 command 不同时不会产生两个 key
 */
function sysToolKey(toolInfo: SystemToolInfo): string {
  return `sys:${toolInfo.packageName}`;
}

function postInstallCommandKey(command: string): string {
  return `post-npm:${command}`;
}

function useInstallHandler() {
  const { t } = useI18n();
  const { setToolInstallStatus, toolInstallStatuses, markPostInstallCommandCompleted } =
    useRuntimeStore();

  const installNpm = useCallback(
    async (packageName: string) => {
      const key = `npm:${packageName}`;
      setToolInstallStatus(key, { status: 'installing', message: '', isNetworkError: false });

      try {
        const shellExec = await createTauriShellExecute({
          sandboxLevel: 'installer',
          subjectType: 'installer',
          subjectId: 'skill-settings:npm',
        });
        const result = await installNpmPackage(packageName, shellExec);
        setToolInstallStatus(key, {
          status: result.success ? 'installed' : 'error',
          message: result.message,
          isNetworkError: result.isNetworkError,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setToolInstallStatus(key, {
          status: 'error',
          message: `${t('settings.skills.installFailed')}: ${msg}`,
          isNetworkError: false,
        });
      }
    },
    [setToolInstallStatus, t]
  );

  const installSysTool = useCallback(
    async (toolInfo: SystemToolInfo, platform: 'windows' | 'mac' | 'linux') => {
      const key = sysToolKey(toolInfo);
      setToolInstallStatus(key, { status: 'installing', message: '', isNetworkError: false });

      try {
        const shellExec = await createTauriShellExecute({
          sandboxLevel: 'installer',
          subjectType: 'installer',
          subjectId: 'skill-settings:system-tool',
        });
        const result = await installSystemTool(toolInfo, platform, shellExec);
        setToolInstallStatus(key, {
          status: result.success ? 'installed' : 'error',
          message: result.message,
          isNetworkError: result.isNetworkError,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setToolInstallStatus(key, {
          status: 'error',
          message: `${t('settings.skills.installFailed')}: ${msg}`,
          isNetworkError: false,
        });
      }
    },
    [setToolInstallStatus, t]
  );

  const installCargo = useCallback(
    async (packageName: string) => {
      const key = `cargo:${packageName}`;
      setToolInstallStatus(key, { status: 'installing', message: '', isNetworkError: false });

      try {
        const shellExec = await createTauriShellExecute({
          sandboxLevel: 'installer',
          subjectType: 'installer',
          subjectId: 'skill-settings:cargo',
        });
        const result = await installCargoPackage(packageName, shellExec);
        setToolInstallStatus(key, {
          status: result.success ? 'installed' : 'error',
          message: result.message,
          isNetworkError: result.isNetworkError,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setToolInstallStatus(key, {
          status: 'error',
          message: `${t('settings.skills.installFailed')}: ${msg}`,
          isNetworkError: false,
        });
      }
    },
    [setToolInstallStatus, t]
  );

  const installGo = useCallback(
    async (modulePath: string) => {
      const key = `go:${modulePath}`;
      setToolInstallStatus(key, { status: 'installing', message: '', isNetworkError: false });

      try {
        const shellExec = await createTauriShellExecute({
          sandboxLevel: 'installer',
          subjectType: 'installer',
          subjectId: 'skill-settings:go',
        });
        const result = await installGoPackage(modulePath, shellExec);
        setToolInstallStatus(key, {
          status: result.success ? 'installed' : 'error',
          message: result.message,
          isNetworkError: result.isNetworkError,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setToolInstallStatus(key, {
          status: 'error',
          message: `${t('settings.skills.installFailed')}: ${msg}`,
          isNetworkError: false,
        });
      }
    },
    [setToolInstallStatus, t]
  );

  const runPostInstallCmd = useCallback(
    async (command: string) => {
      const key = postInstallCommandKey(command);
      setToolInstallStatus(key, { status: 'installing', message: '', isNetworkError: false });

      try {
        const shellExec = await createTauriShellExecute({
          sandboxLevel: 'installer',
          subjectType: 'installer',
          subjectId: 'skill-settings:post-install',
        });
        const result = await shellExec({
          command,
          workdir: '.',
          timeout: 300, // 浏览器下载可能较慢
          background: false,
        });

        if (result.exitCode === 0) {
          markPostInstallCommandCompleted(key);
          setToolInstallStatus(key, {
            status: 'installed',
            message: t('common.completed'),
            isNetworkError: false,
          });
        } else {
          const combinedOutput = `${result.stdout}\n${result.stderr}`;
          const networkErr = isNetworkRelatedError(combinedOutput);
          const chromeForTestingErr = isChromeForTestingInstallFailure(command, combinedOutput);
          const failureOutput = result.stderr.trim() || result.stdout.trim() || combinedOutput;
          setToolInstallStatus(key, {
            status: 'error',
            message: chromeForTestingErr
              ? t('settings.skills.chromeForTestingInstallNetworkHint')
              : formatPostInstallFailureMessage(command, failureOutput, networkErr, t),
            isNetworkError: networkErr || chromeForTestingErr,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const chromeForTestingErr = isChromeForTestingInstallFailure(command, msg);
        setToolInstallStatus(key, {
          status: 'error',
          message: chromeForTestingErr
            ? t('settings.skills.chromeForTestingInstallNetworkHint')
            : `${t('settings.skills.operationFailed')}: ${msg}`,
          isNetworkError: chromeForTestingErr,
        });
      }
    },
    [markPostInstallCommandCompleted, setToolInstallStatus, t]
  );

  const getStatus = useCallback(
    (key: string): ToolInstallEntry | undefined => {
      return toolInstallStatuses[key];
    },
    [toolInstallStatuses]
  );

  return { installNpm, installSysTool, installCargo, installGo, runPostInstallCmd, getStatus };
}

/**
 * 技能列表区域
 */
function SkillListSection() {
  const { t } = useI18n();
  const { toast } = useToast();
  const installedSkills = useInstalledSkills();
  const { copiedKey, copyText } = useCopyToClipboard();
  const platform = detectPlatform();
  const { installNpm, installSysTool, installCargo, installGo, runPostInstallCmd, getStatus } =
    useInstallHandler();
  const { setToolInstallStatus, toggleSkillEnabled, completedPostInstallCommands } =
    useRuntimeStore();
  const hasPreChecked = useRef(false);

  // 折叠状态管理：记录当前已展开的技能名称（默认全部折叠）
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  // 删除状态管理
  const [pendingDelete, setPendingDelete] = useState<{ name: string; packagePath: string } | null>(
    null
  );
  const [isDeleting, setIsDeleting] = useState(false);

  // 执行卸载操作（由 ConfirmDialog 的 onConfirm 触发）
  const executeDelete = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      setIsDeleting(true);
      await uninstallSkill(pendingDelete.packagePath, pendingDelete.name);
      logger.debug(`[SkillSettings] 技能 "${pendingDelete.name}" 已卸载`);
    } catch (error) {
      logger.error(
        '[SkillSettings] 卸载技能失败:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  }, [pendingDelete]);

  const toggleSkillExpand = useCallback((skillName: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillName)) {
        next.delete(skillName);
      } else {
        next.add(skillName);
      }
      return next;
    });
  }, []);

  const handleOpenSkillFolder = useCallback(
    async (packagePath: string) => {
      try {
        await invoke('file_open_system', { filePath: packagePath });
      } catch (error) {
        logger.error('[SkillSettings] 打开技能目录失败:', error);
        toast({
          type: 'error',
          title: t('settings.skills.openSkillFolderFailed'),
          description: String(error),
        });
      }
    },
    [t, toast]
  );

  // 组件挂载时预检测所有系统工具和 npm 包的安装状态
  // 避免用户重启后看到「未安装」按钮对已安装的工具
  useEffect(() => {
    if (hasPreChecked.current || installedSkills.length === 0) return;
    hasPreChecked.current = true;

    const preCheckAll = async () => {
      try {
        const shellExec = await createTauriShellExecute({
          sandboxLevel: 'installer',
          subjectType: 'installer',
          subjectId: 'skill-settings:precheck',
        });

        // 收集所有需要检测的工具（按 packageName 去重）
        const sysToolsMap = new Map<string, SystemToolInfo>();
        const npmPackages = new Set<string>();
        const npmPostInstallCommands = new Map<string, { npmPackage: string; command: string }>();

        for (const skill of installedSkills) {
          for (const tool of skill.systemDependencies) {
            if (!sysToolsMap.has(tool.packageName)) {
              sysToolsMap.set(tool.packageName, tool);
            }
          }
          for (const pkg of skill.npmDependencies) {
            npmPackages.add(pkg);
          }
          for (const postInstall of skill.npmPostInstallCommands) {
            npmPostInstallCommands.set(postInstallCommandKey(postInstall.command), postInstall);
          }
          // cargo 和 go 包复用同样的预检测模式
          // 但 cargo/go 包的检测需要不同逻辑，在下方单独处理
        }

        // 并行检测系统工具
        const sysChecks = Array.from(sysToolsMap.entries()).map(async ([, tool]) => {
          const checkCmd = tool.detectCommand ?? tool.command;
          const key = sysToolKey(tool);
          // 跳过已有状态的（用户刚安装过，状态还在内存中）
          const existing = useRuntimeStore.getState().toolInstallStatuses[key];
          if (existing && existing.status !== 'idle') return;

          setToolInstallStatus(key, { status: 'checking', message: '', isNetworkError: false });
          const available = await isCommandAvailableWithFreshPath(
            checkCmd,
            shellExec,
            tool.windowsExePaths
          );
          setToolInstallStatus(key, {
            status: available ? 'installed' : 'idle',
            message: available ? `${tool.packageName} ${t('common.installed')}` : '',
            isNetworkError: false,
          });
        });

        // 并行检测 npm 包
        const npmChecks = Array.from(npmPackages).map(async (pkg) => {
          const key = `npm:${pkg}`;
          const existing = useRuntimeStore.getState().toolInstallStatuses[key];
          if (existing && existing.status !== 'idle') return;

          setToolInstallStatus(key, { status: 'checking', message: '', isNetworkError: false });
          const available = await isNpmPackageInstalled(pkg, shellExec);
          setToolInstallStatus(key, {
            status: available ? 'installed' : 'idle',
            message: available ? `${pkg} ${t('common.installed')}` : '',
            isNetworkError: false,
          });
        });

        await Promise.all([...sysChecks, ...npmChecks]);

        // npm 后置命令通常没有稳定的无副作用探测命令。
        // 若用户曾成功执行过，则在确认 npm 包仍存在后恢复为“已完成”。
        const postInstallChecks = Array.from(npmPostInstallCommands.entries()).map(
          async ([key, postInstall]) => {
            const existing = useRuntimeStore.getState().toolInstallStatuses[key];
            if (existing && existing.status !== 'idle') return;
            if (!completedPostInstallCommands[key]) return;

            const npmStatus =
              useRuntimeStore.getState().toolInstallStatuses[`npm:${postInstall.npmPackage}`];
            const npmAvailable =
              npmStatus?.status === 'installed' ||
              (await isNpmPackageInstalled(postInstall.npmPackage, shellExec));
            if (!npmAvailable) return;

            setToolInstallStatus(key, {
              status: 'installed',
              message: t('common.completed'),
              isNetworkError: false,
            });
          }
        );

        // 并行检测 cargo 包
        const cargoPackages = new Set<string>();
        for (const skill of installedSkills) {
          for (const pkg of skill.cargoDependencies) {
            cargoPackages.add(pkg);
          }
        }
        const cargoChecks = Array.from(cargoPackages).map(async (pkg) => {
          const key = `cargo:${pkg}`;
          const existing = useRuntimeStore.getState().toolInstallStatuses[key];
          if (existing && existing.status !== 'idle') return;

          setToolInstallStatus(key, { status: 'checking', message: '', isNetworkError: false });
          const available = await isCargoPackageInstalled(pkg, shellExec);
          setToolInstallStatus(key, {
            status: available ? 'installed' : 'idle',
            message: available ? `${pkg} ${t('common.installed')}` : '',
            isNetworkError: false,
          });
        });

        // 并行检测 go 包
        const goPackages = new Set<string>();
        for (const skill of installedSkills) {
          for (const pkg of skill.goDependencies) {
            goPackages.add(pkg);
          }
        }
        const goChecks = Array.from(goPackages).map(async (pkg) => {
          const key = `go:${pkg}`;
          const existing = useRuntimeStore.getState().toolInstallStatuses[key];
          if (existing && existing.status !== 'idle') return;

          setToolInstallStatus(key, { status: 'checking', message: '', isNetworkError: false });
          const available = await isGoPackageInstalled(pkg, shellExec);
          setToolInstallStatus(key, {
            status: available ? 'installed' : 'idle',
            message: available ? `${pkg} ${t('common.installed')}` : '',
            isNetworkError: false,
          });
        });

        await Promise.all([...postInstallChecks, ...cargoChecks, ...goChecks]);
      } catch (error) {
        logger.warn('[SkillSettings] 预检测工具安装状态失败:', error);
      }
    };

    void preCheckAll();
  }, [completedPostInstallCommands, installedSkills, setToolInstallStatus, t]);

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('settings.skills.installedSkills')}</h3>
      <p className={styles.hint}>{t('settings.skills.installedSkillsDependencyHint')}</p>

      {installedSkills.length === 0 ? (
        <div className={styles.emptyState}>{t('settings.skills.emptyInstalled')}</div>
      ) : (
        <div className={styles.skillList}>
          {installedSkills.map((skill) => {
            // 计算是否有非 pip 依赖需要关注
            const hasNpmDeps = skill.npmDependencies.length > 0;
            const hasCargoDeps = skill.cargoDependencies.length > 0;
            const hasGoDeps = skill.goDependencies.length > 0;
            const hasSystemDeps = skill.systemDependencies.length > 0;
            return (
              <div
                key={skill.name}
                className={cx(styles.skillCard, !skill.enabled && styles.skillCardDisabled)}
              >
                {/* 可点击的头部区域：状态图标 + 开关 + 名称 + 描述 + 折叠按钮 */}
                <div
                  className={styles.skillCardHeader}
                  onClick={() => toggleSkillExpand(skill.name)}
                >
                  {/* 状态图标 */}
                  <div
                    className={cx(
                      styles.skillStatusIcon,
                      skill.dependencyStatus === 'satisfied'
                        ? styles.statusReady
                        : skill.dependencyStatus === 'pending'
                          ? styles.statusPending
                          : styles.statusError
                    )}
                  >
                    {skill.dependencyStatus === 'satisfied' ? (
                      <CheckCircle size={16} />
                    ) : skill.dependencyStatus === 'pending' ? (
                      <AlertTriangle size={16} />
                    ) : (
                      <XCircle size={16} />
                    )}
                  </div>

                  {/* 技能基本信息（始终可见） */}
                  <div className={styles.skillInfo}>
                    <div className={styles.skillNameRow}>
                      <span className={styles.skillName}>{skill.name}</span>
                      <span className={styles.skillModeBadge}>{skill.mode}</span>
                    </div>
                    <Tooltip content={skill.description} multiline side="bottom" align="start">
                      <p className={styles.skillDescription}>{skill.description}</p>
                    </Tooltip>
                  </div>

                  {/* 启用/禁用开关 */}
                  <Tooltip
                    content={
                      skill.enabled
                        ? t('settings.skills.disableTitle')
                        : t('settings.skills.enableTitle')
                    }
                  >
                    <button
                      className={cx(styles.skillToggle, !skill.enabled && styles.skillToggleOff)}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSkillEnabled(skill.name);
                      }}
                      aria-label={
                        skill.enabled
                          ? t('settings.skills.disableTitle')
                          : t('settings.skills.enableTitle')
                      }
                    >
                      <Power size={14} />
                    </button>
                  </Tooltip>

                  {/* 折叠/展开图标 */}
                  <div className={styles.collapseToggle}>
                    {expandedSkills.has(skill.name) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </div>
                </div>

                {/* 展开区域：依赖详情 */}
                {expandedSkills.has(skill.name) && (
                  <div className={styles.skillExpandedContent}>
                    {skill.missingDependencies.length > 0 && (
                      <p className={styles.skillMissing}>
                        {t('settings.skills.missing', {
                          items: skill.missingDependencies.join(', '),
                        })}
                      </p>
                    )}

                    {/* npm 依赖引导 */}
                    {hasNpmDeps && (
                      <div className={styles.manualDepSection}>
                        <div className={styles.manualDepHeader}>
                          <Package size={12} />
                          <span>{t('settings.skills.needNpm')}</span>
                        </div>
                        {skill.npmDependencies.map((pkg) => {
                          const cmd = `npm install -g ${pkg}`;
                          const copyKey = `npm-${skill.name}-${pkg}`;
                          const storeKey = `npm:${pkg}`;
                          const installStatus = getStatus(storeKey);
                          const isChecking = installStatus?.status === 'checking';
                          const isInstalling = installStatus?.status === 'installing';
                          const isInstalled = installStatus?.status === 'installed';
                          const isError = installStatus?.status === 'error';
                          const isBusy = isChecking || isInstalling;

                          return (
                            <div key={pkg} className={styles.manualDepItem}>
                              <div className={styles.depToolInfo}>
                                <code className={styles.depCommand}>{cmd}</code>
                              </div>
                              <div className={styles.depActions}>
                                {/* 复制按钮 */}
                                <Tooltip content={t('settings.skills.copyInstallCommand')}>
                                  <button
                                    className={styles.copyButton}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void copyText(cmd, copyKey);
                                    }}
                                    aria-label={t('settings.skills.copyInstallCommand')}
                                  >
                                    {copiedKey === copyKey ? (
                                      <CheckCircle size={12} />
                                    ) : (
                                      <Copy size={12} />
                                    )}
                                  </button>
                                </Tooltip>
                                {/* 安装状态 pill 按钮 */}
                                <Tooltip
                                  content={getDependencyActionTitle(
                                    isChecking,
                                    isInstalling,
                                    isInstalled,
                                    isError,
                                    t
                                  )}
                                >
                                  <span className={styles.tooltipButtonWrap}>
                                    <button
                                      className={cx(
                                        styles.installPill,
                                        isInstalled
                                          ? styles.installPillSuccess
                                          : isError
                                            ? styles.installPillError
                                            : isBusy
                                              ? styles.installPillBusy
                                              : undefined
                                      )}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void installNpm(pkg);
                                      }}
                                      disabled={isBusy || isInstalled}
                                      aria-label={getDependencyActionTitle(
                                        isChecking,
                                        isInstalling,
                                        isInstalled,
                                        isError,
                                        t
                                      )}
                                    >
                                      {isChecking ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.checking')}
                                        </>
                                      ) : isInstalling ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.installing')}
                                        </>
                                      ) : isInstalled ? (
                                        <>
                                          <CheckCircle size={10} /> {t('common.installed')}
                                        </>
                                      ) : isError ? (
                                        <>
                                          <RotateCw size={10} /> {t('common.retry')}
                                        </>
                                      ) : (
                                        <>
                                          <Download size={10} /> {t('common.install')}
                                        </>
                                      )}
                                    </button>
                                  </span>
                                </Tooltip>
                              </div>
                              {/* 错误消息 */}
                              {isError && installStatus.message && (
                                <div
                                  className={cx(
                                    styles.depMessage,
                                    installStatus.isNetworkError
                                      ? styles.depMessageNetwork
                                      : styles.depMessageError
                                  )}
                                >
                                  {installStatus.message}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* npm 包后置安装命令（如 agent-browser install） */}
                    {skill.npmPostInstallCommands.length > 0 && (
                      <div className={styles.manualDepSection}>
                        <div className={styles.manualDepHeader}>
                          <Terminal size={12} />
                          <span>{t('settings.skills.needPostInstall')}</span>
                        </div>
                        {skill.npmPostInstallCommands.map(({ npmPackage, command }) => {
                          const copyKey = `npm-post-${skill.name}-${command}`;
                          const storeKey = postInstallCommandKey(command);
                          const installStatus = getStatus(storeKey);
                          const isChecking = installStatus?.status === 'checking';
                          const isInstalling = installStatus?.status === 'installing';
                          const isInstalled = installStatus?.status === 'installed';
                          const isError = installStatus?.status === 'error';
                          const isBusy = isChecking || isInstalling;

                          return (
                            <div key={`${npmPackage}-${command}`} className={styles.manualDepItem}>
                              <div className={styles.depToolInfo}>
                                <code className={styles.depCommand}>{command}</code>
                              </div>
                              <div className={styles.depActions}>
                                <Tooltip content={t('settings.skills.copyCommand')}>
                                  <button
                                    className={styles.copyButton}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void copyText(command, copyKey);
                                    }}
                                    aria-label={t('settings.skills.copyCommand')}
                                  >
                                    {copiedKey === copyKey ? (
                                      <CheckCircle size={12} />
                                    ) : (
                                      <Copy size={12} />
                                    )}
                                  </button>
                                </Tooltip>
                                {/* 执行按钮 */}
                                <Tooltip
                                  content={getPostInstallActionTitle(
                                    isChecking,
                                    isInstalling,
                                    isInstalled,
                                    isError,
                                    t
                                  )}
                                >
                                  <span className={styles.tooltipButtonWrap}>
                                    <button
                                      className={cx(
                                        styles.installPill,
                                        isInstalled
                                          ? styles.installPillSuccess
                                          : isError
                                            ? styles.installPillError
                                            : isBusy
                                              ? styles.installPillBusy
                                              : undefined
                                      )}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void runPostInstallCmd(command);
                                      }}
                                      disabled={isBusy || isInstalled}
                                      aria-label={getPostInstallActionTitle(
                                        isChecking,
                                        isInstalling,
                                        isInstalled,
                                        isError,
                                        t
                                      )}
                                    >
                                      {isChecking ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.checking')}
                                        </>
                                      ) : isInstalling ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.executing')}
                                        </>
                                      ) : isInstalled ? (
                                        <>
                                          <CheckCircle size={10} /> {t('common.completed')}
                                        </>
                                      ) : isError ? (
                                        <>
                                          <RotateCw size={10} /> {t('common.retry')}
                                        </>
                                      ) : (
                                        <>
                                          <Download size={10} /> {t('common.execute')}
                                        </>
                                      )}
                                    </button>
                                  </span>
                                </Tooltip>
                              </div>
                              {/* 错误消息 */}
                              {isError && installStatus.message && (
                                <div
                                  className={cx(
                                    styles.depMessage,
                                    installStatus.isNetworkError
                                      ? styles.depMessageNetwork
                                      : styles.depMessageError
                                  )}
                                >
                                  {installStatus.message}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* cargo 依赖引导 */}
                    {hasCargoDeps && (
                      <div className={styles.manualDepSection}>
                        <div className={styles.manualDepHeader}>
                          <Package size={12} />
                          <span>{t('settings.skills.needCargo')}</span>
                        </div>
                        {skill.cargoDependencies.map((pkg) => {
                          const cmd = `cargo install ${pkg}`;
                          const copyKey = `cargo-${skill.name}-${pkg}`;
                          const storeKey = `cargo:${pkg}`;
                          const installStatus = getStatus(storeKey);
                          const isChecking = installStatus?.status === 'checking';
                          const isInstalling = installStatus?.status === 'installing';
                          const isInstalled = installStatus?.status === 'installed';
                          const isError = installStatus?.status === 'error';
                          const isBusy = isChecking || isInstalling;

                          return (
                            <div key={pkg} className={styles.manualDepItem}>
                              <div className={styles.depToolInfo}>
                                <code className={styles.depCommand}>{cmd}</code>
                              </div>
                              <div className={styles.depActions}>
                                <Tooltip content={t('settings.skills.copyInstallCommand')}>
                                  <button
                                    className={styles.copyButton}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void copyText(cmd, copyKey);
                                    }}
                                    aria-label={t('settings.skills.copyInstallCommand')}
                                  >
                                    {copiedKey === copyKey ? (
                                      <CheckCircle size={12} />
                                    ) : (
                                      <Copy size={12} />
                                    )}
                                  </button>
                                </Tooltip>
                                <Tooltip
                                  content={getDependencyActionTitle(
                                    isChecking,
                                    isInstalling,
                                    isInstalled,
                                    isError,
                                    t
                                  )}
                                >
                                  <span className={styles.tooltipButtonWrap}>
                                    <button
                                      className={cx(
                                        styles.installPill,
                                        isInstalled
                                          ? styles.installPillSuccess
                                          : isError
                                            ? styles.installPillError
                                            : isBusy
                                              ? styles.installPillBusy
                                              : undefined
                                      )}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void installCargo(pkg);
                                      }}
                                      disabled={isBusy || isInstalled}
                                      aria-label={getDependencyActionTitle(
                                        isChecking,
                                        isInstalling,
                                        isInstalled,
                                        isError,
                                        t
                                      )}
                                    >
                                      {isChecking ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.checking')}
                                        </>
                                      ) : isInstalling ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.installing')}
                                        </>
                                      ) : isInstalled ? (
                                        <>
                                          <CheckCircle size={10} /> {t('common.installed')}
                                        </>
                                      ) : isError ? (
                                        <>
                                          <RotateCw size={10} /> {t('common.retry')}
                                        </>
                                      ) : (
                                        <>
                                          <Download size={10} /> {t('common.install')}
                                        </>
                                      )}
                                    </button>
                                  </span>
                                </Tooltip>
                              </div>
                              {isError && installStatus.message && (
                                <div
                                  className={cx(
                                    styles.depMessage,
                                    installStatus.isNetworkError
                                      ? styles.depMessageNetwork
                                      : styles.depMessageError
                                  )}
                                >
                                  {installStatus.message}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* go 依赖引导 */}
                    {hasGoDeps && (
                      <div className={styles.manualDepSection}>
                        <div className={styles.manualDepHeader}>
                          <Package size={12} />
                          <span>{t('settings.skills.needGo')}</span>
                        </div>
                        {skill.goDependencies.map((pkg) => {
                          const cmd = `go install ${pkg}@latest`;
                          const copyKey = `go-${skill.name}-${pkg}`;
                          const storeKey = `go:${pkg}`;
                          const installStatus = getStatus(storeKey);
                          const isChecking = installStatus?.status === 'checking';
                          const isInstalling = installStatus?.status === 'installing';
                          const isInstalled = installStatus?.status === 'installed';
                          const isError = installStatus?.status === 'error';
                          const isBusy = isChecking || isInstalling;

                          return (
                            <div key={pkg} className={styles.manualDepItem}>
                              <div className={styles.depToolInfo}>
                                <code className={styles.depCommand}>{cmd}</code>
                              </div>
                              <div className={styles.depActions}>
                                <Tooltip content={t('settings.skills.copyInstallCommand')}>
                                  <button
                                    className={styles.copyButton}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void copyText(cmd, copyKey);
                                    }}
                                    aria-label={t('settings.skills.copyInstallCommand')}
                                  >
                                    {copiedKey === copyKey ? (
                                      <CheckCircle size={12} />
                                    ) : (
                                      <Copy size={12} />
                                    )}
                                  </button>
                                </Tooltip>
                                <Tooltip
                                  content={getDependencyActionTitle(
                                    isChecking,
                                    isInstalling,
                                    isInstalled,
                                    isError,
                                    t
                                  )}
                                >
                                  <span className={styles.tooltipButtonWrap}>
                                    <button
                                      className={cx(
                                        styles.installPill,
                                        isInstalled
                                          ? styles.installPillSuccess
                                          : isError
                                            ? styles.installPillError
                                            : isBusy
                                              ? styles.installPillBusy
                                              : undefined
                                      )}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void installGo(pkg);
                                      }}
                                      disabled={isBusy || isInstalled}
                                      aria-label={getDependencyActionTitle(
                                        isChecking,
                                        isInstalling,
                                        isInstalled,
                                        isError,
                                        t
                                      )}
                                    >
                                      {isChecking ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.checking')}
                                        </>
                                      ) : isInstalling ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.installing')}
                                        </>
                                      ) : isInstalled ? (
                                        <>
                                          <CheckCircle size={10} /> {t('common.installed')}
                                        </>
                                      ) : isError ? (
                                        <>
                                          <RotateCw size={10} /> {t('common.retry')}
                                        </>
                                      ) : (
                                        <>
                                          <Download size={10} /> {t('common.install')}
                                        </>
                                      )}
                                    </button>
                                  </span>
                                </Tooltip>
                              </div>
                              {isError && installStatus.message && (
                                <div
                                  className={cx(
                                    styles.depMessage,
                                    installStatus.isNetworkError
                                      ? styles.depMessageNetwork
                                      : styles.depMessageError
                                  )}
                                >
                                  {installStatus.message}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* 系统工具引导 */}
                    {hasSystemDeps && (
                      <div className={styles.manualDepSection}>
                        <div className={styles.manualDepHeader}>
                          <Terminal size={12} />
                          <span>{t('settings.skills.needSystemTool')}</span>
                        </div>
                        {skill.systemDependencies.map((tool) => {
                          const installCmd =
                            platform === 'windows'
                              ? tool.windowsInstall
                              : platform === 'mac'
                                ? tool.macInstall
                                : tool.linuxInstall;
                          const copyKey = `sys-${skill.name}-${tool.command}`;
                          const storeKey = sysToolKey(tool);
                          const installStatus = getStatus(storeKey);
                          const isChecking = installStatus?.status === 'checking';
                          const isInstalling = installStatus?.status === 'installing';
                          const isInstalled = installStatus?.status === 'installed';
                          const isError = installStatus?.status === 'error';
                          const isBusy = isChecking || isInstalling;

                          return (
                            <div key={tool.command} className={styles.manualDepItem}>
                              <div className={styles.depToolInfo}>
                                <span className={styles.depToolName}>{tool.packageName}</span>
                                <code className={styles.depCommand}>{installCmd}</code>
                              </div>
                              <div className={styles.depActions}>
                                {/* 复制按钮 */}
                                <Tooltip content={t('settings.skills.copyInstallCommand')}>
                                  <button
                                    className={styles.copyButton}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void copyText(installCmd, copyKey);
                                    }}
                                    aria-label={t('settings.skills.copyInstallCommand')}
                                  >
                                    {copiedKey === copyKey ? (
                                      <CheckCircle size={12} />
                                    ) : (
                                      <Copy size={12} />
                                    )}
                                  </button>
                                </Tooltip>
                                {/* 安装状态 pill 按钮 */}
                                <Tooltip
                                  content={getDependencyActionTitle(
                                    isChecking,
                                    isInstalling,
                                    isInstalled,
                                    isError,
                                    t
                                  )}
                                >
                                  <span className={styles.tooltipButtonWrap}>
                                    <button
                                      className={cx(
                                        styles.installPill,
                                        isInstalled
                                          ? styles.installPillSuccess
                                          : isError
                                            ? styles.installPillError
                                            : isBusy
                                              ? styles.installPillBusy
                                              : undefined
                                      )}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void installSysTool(tool, platform);
                                      }}
                                      disabled={isBusy || isInstalled}
                                      aria-label={getDependencyActionTitle(
                                        isChecking,
                                        isInstalling,
                                        isInstalled,
                                        isError,
                                        t
                                      )}
                                    >
                                      {isChecking ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.checking')}
                                        </>
                                      ) : isInstalling ? (
                                        <>
                                          <Loader2 size={10} className={styles.spinning} />{' '}
                                          {t('common.installing')}
                                        </>
                                      ) : isInstalled ? (
                                        <>
                                          <CheckCircle size={10} /> {t('common.installed')}
                                        </>
                                      ) : isError ? (
                                        <>
                                          <RotateCw size={10} /> {t('common.retry')}
                                        </>
                                      ) : (
                                        <>
                                          <Download size={10} /> {t('common.install')}
                                        </>
                                      )}
                                    </button>
                                  </span>
                                </Tooltip>
                              </div>
                              {/* 错误消息（支持换行和可点击 URL） */}
                              {isError && installStatus.message && (
                                <div
                                  className={cx(
                                    styles.depMessage,
                                    installStatus.isNetworkError
                                      ? styles.depMessageNetwork
                                      : styles.depMessageError
                                  )}
                                >
                                  <DepErrorMessage message={installStatus.message} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* 安装依赖按钮 */}
                    {skill.dependencyStatus === 'pending' && (
                      <Tooltip content={t('settings.skills.installDeps')}>
                        <button
                          className={styles.installDepsButton}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {t('settings.skills.installDeps')}
                        </button>
                      </Tooltip>
                    )}

                    {/* 技能操作按钮 */}
                    <div className={styles.skillExpandedActions}>
                      <Tooltip content={t('settings.skills.openSkillFolderTitle')}>
                        <button
                          className={styles.openSkillButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleOpenSkillFolder(skill.packagePath);
                          }}
                          aria-label={t('settings.skills.openSkillFolderTitle')}
                        >
                          <FolderOpen size={12} />
                          {t('common.open')}
                        </button>
                      </Tooltip>
                      <button
                        className={styles.deleteSkillButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete({ name: skill.name, packagePath: skill.packagePath });
                        }}
                        disabled={isDeleting}
                      >
                        <Trash2 size={12} />
                        {t('common.delete')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={executeDelete}
        title={t('settings.skills.deleteSkill')}
        description={t('settings.skills.deleteSkillDescription', {
          name: pendingDelete?.name ?? '',
        })}
        confirmText={t('common.confirmDelete')}
        variant="danger"
        isLoading={isDeleting}
      />
    </section>
  );
}

/**
 * 安装新技能区域
 */
function InstallSection() {
  const { t, language } = useI18n();
  const [githubUrl, setGithubUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isInstallingFromGithub, setIsInstallingFromGithub] = useState(false);
  const [resultMessage, setResultMessage] = useState<ResultMessage | null>(null);
  // 审查决策处理中状态（防止 handleAuditDecision 异步期间重复点击）
  const [isAuditProcessing, setIsAuditProcessing] = useState(false);
  const [pendingAuditConfirm, setPendingAuditConfirm] = useState<PendingSkillInstall | null>(null);

  // 消费后台自动安装的结果消息（重启后 bootstrapExternalSkills 触发的安装）
  const depInstallResult = useRuntimeStore((s) => s.depInstallResultMessage);
  useEffect(() => {
    if (depInstallResult) {
      setResultMessage(depInstallResult);
      // 消费后清除，避免重复显示
      useRuntimeStore.getState().setDepInstallResultMessage(null);
    }
  }, [depInstallResult]);

  // 审查中转状态：保存待审查的包路径，在审查完成后根据用户决策处理
  const pendingAuditRef = useRef<PendingSkillInstall | null>(null);

  // 导入文件夹：复制后先让用户选择审查或直接安装
  const handleImportFolder = useCallback(async () => {
    try {
      setIsImporting(true);
      setResultMessage(null);

      // 打开目录选择对话框
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: t('settings.skills.selectSkillFolder'),
      });

      if (!selectedPath || typeof selectedPath !== 'string') {
        return;
      }

      // 阶段 1：仅复制文件到 packages/
      const { destPath, skillName } = await copySkillPackageToPackagesDir(selectedPath);
      const pending: PendingSkillInstall = { destPath, skillName, source: 'local' };
      pendingAuditRef.current = pending;
      setPendingAuditConfirm(pending);
    } catch (error) {
      useRuntimeStore.getState().clearSkillAudit();
      setResultMessage({
        type: 'error',
        text: translateSkillInstallError(
          getErrorMessage(error, t('settings.skills.importFailed')),
          t
        ),
      });
      pendingAuditRef.current = null;
    } finally {
      setIsImporting(false);
    }
  }, [t]);

  const handleStartAuditFromConfirm = useCallback(async () => {
    const pending = pendingAuditConfirm;
    if (!pending || isAuditProcessing) return;

    try {
      setIsAuditProcessing(true);
      setPendingAuditConfirm(null);
      setResultMessage(null);
      pendingAuditRef.current = pending;
      useRuntimeStore.getState().prepareSkillAudit(pending.destPath);

      const listFiles = await createPackageListFiles();
      const fileList = await collectPackageFiles(pending.destPath, listFiles);
      await auditSkillPackage(pending.destPath, fileList, language);

      if (pending.source === 'github') {
        setGithubUrl('');
      }
    } catch (error) {
      const { clearSkillAudit, setGitHubInstallStatus, setGitHubInstallError } =
        useRuntimeStore.getState();
      const errorMsg = translateSkillInstallError(
        getErrorMessage(
          error,
          pending.source === 'local'
            ? t('settings.skills.importFailed')
            : t('settings.skills.installFailed')
        ),
        t
      );
      clearSkillAudit();
      if (pending.source === 'github') {
        setGitHubInstallStatus('error');
        setGitHubInstallError(errorMsg);
      }
      setResultMessage({ type: 'error', text: errorMsg });
      pendingAuditRef.current = null;
    } finally {
      setIsAuditProcessing(false);
    }
  }, [isAuditProcessing, language, pendingAuditConfirm, t]);

  // 处理用户对审查结果的决策
  const handleAuditDecision = useCallback(
    async (decision: AuditUserDecision) => {
      const pending = pendingAuditRef.current;
      const {
        clearSkillAudit,
        skillAuditPackagePath,
        setGitHubInstallStatus,
        setGitHubInstallError,
      } = useRuntimeStore.getState();
      // 也支持 GitHub 安装的包路径
      const packagePath = pending?.destPath ?? skillAuditPackagePath;

      // 限制重入：如果已在处理中，忽略重复点击
      if (isAuditProcessing) return;

      try {
        setIsAuditProcessing(true);
        switch (decision) {
          case 'proceed': {
            // 用户确认安装 → 触发 rescan 注册技能（依赖安装异步进行）
            await rescanExternalSkills();
            const skillName =
              pending?.skillName ??
              packagePath?.split(/[\\/]/).pop() ??
              t('settings.skills.skillPackageFallback');
            // 技能包本身已注册成功，依赖安装结果稍后通过 depInstallResultMessage 异步展示
            setResultMessage({
              type: 'success',
              text: t('settings.skills.registeredInBackground', { name: skillName }),
            });
            if (pending?.source === 'github') {
              setGithubUrl('');
            }
            break;
          }
          case 'remove': {
            // 用户拒绝安装 → 删除已复制的包目录
            if (packagePath) {
              await removeSkillPackage(packagePath);
            }
            setResultMessage({
              type: 'success',
              text: t('settings.skills.installCanceledCleaned'),
            });
            break;
          }
          case 'cancel': {
            // 审查服务不可用时用户取消 → 删除已复制的包目录
            if (packagePath) {
              await removeSkillPackage(packagePath);
            }
            setResultMessage(null);
            break;
          }
        }
      } catch (error) {
        setResultMessage({
          type: 'error',
          text: getErrorMessage(error, t('settings.skills.operationFailed')),
        });
      } finally {
        setIsAuditProcessing(false);
        setGitHubInstallStatus('idle');
        setGitHubInstallError(null);
        clearSkillAudit();
        pendingAuditRef.current = null;
      }
    },
    [isAuditProcessing, t]
  );

  const handleDirectInstallFromConfirm = useCallback(() => {
    const pending = pendingAuditConfirm;
    if (!pending || isAuditProcessing) return;

    setPendingAuditConfirm(null);
    pendingAuditRef.current = pending;
    void handleAuditDecision('proceed');
  }, [handleAuditDecision, isAuditProcessing, pendingAuditConfirm]);

  // 刷新列表并重试安装失败的依赖
  const handleRefreshList = useCallback(async () => {
    try {
      setIsRefreshing(true);
      setResultMessage(null);

      // rescan 立即返回（扫描注册完成），依赖安装在后台异步进行
      // 安装结果通过 depInstallResultMessage Store 字段异步推送，
      // 下方的 useEffect 检测到变化后会自动合并到 resultMessage 展示
      await rescanExternalSkills();
      setResultMessage({ type: 'success', text: t('settings.skills.refreshedInBackground') });
    } catch (error) {
      setResultMessage({
        type: 'error',
        text: getErrorMessage(error, t('settings.skills.refreshFailed')),
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [t]);

  // 从 GitHub 安装：下载后先让用户选择审查或直接安装
  const handleInstallFromGithub = useCallback(async () => {
    const trimmedUrl = githubUrl.trim();
    if (!trimmedUrl) return;

    try {
      setIsInstallingFromGithub(true);
      setResultMessage(null);

      const { setGitHubInstallStatus, setGitHubInstallError } = useRuntimeStore.getState();
      setGitHubInstallStatus('downloading');
      setGitHubInstallError(null);

      // 获取 packages 目录
      const { getPackagesDir } =
        await import('@services/planning/skills/external/ExternalSkillBootstrap');
      const packagesDir = await getPackagesDir();
      if (!packagesDir) {
        throw new Error(t('settings.skills.cannotGetPackagesDir'));
      }

      // 调用 Rust 后端下载安装
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<{
        skillName: string;
        filesWritten: number;
        packagePath: string;
      }>('skill_install_from_github', {
        params: {
          githubUrl: trimmedUrl,
          packagesDir,
        },
      });

      setGitHubInstallStatus('done');

      // 保存包路径到审查中转状态
      const pending: PendingSkillInstall = {
        destPath: result.packagePath,
        skillName: result.skillName,
        source: 'github',
      };
      pendingAuditRef.current = pending;
      setPendingAuditConfirm(pending);
    } catch (error) {
      const {
        setGitHubInstallStatus: setFailStatus,
        setGitHubInstallError,
        clearSkillAudit,
      } = useRuntimeStore.getState();
      setFailStatus('error');
      const errorMsg = translateSkillInstallError(
        getErrorMessage(error, t('settings.skills.installFailed')),
        t
      );
      setGitHubInstallError(errorMsg);
      setResultMessage({ type: 'error', text: errorMsg });
      clearSkillAudit();
      pendingAuditRef.current = null;
    } finally {
      setIsInstallingFromGithub(false);
    }
  }, [githubUrl, t]);

  const auditStatus = useRuntimeStore((s) => s.skillAuditStatus);
  const githubInstallStatus = useRuntimeStore((s) => s.githubInstallStatus);
  const githubInstallError = useRuntimeStore((s) => s.githubInstallError);
  const isGithubInstallBusy =
    isInstallingFromGithub ||
    githubInstallStatus === 'downloading' ||
    githubInstallStatus === 'extracting';
  const isProcessing =
    isImporting ||
    isGithubInstallBusy ||
    isRefreshing ||
    isAuditProcessing ||
    pendingAuditConfirm !== null ||
    auditStatus !== 'idle';
  const visibleResultMessage =
    resultMessage ??
    (githubInstallError ? { type: 'error' as const, text: githubInstallError } : null);

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('settings.skills.importNewSkill')}</h3>
      {/* 提示用户：安装或修改技能内容后，需手动刷新列表才能使变更生效 */}
      <p className={styles.hint}>{t('settings.skills.installHint')}</p>

      <div className={styles.installActions}>
        {/* 导入文件夹 */}
        <div className={styles.buttonRow}>
          <button
            className={styles.actionButton}
            onClick={handleImportFolder}
            disabled={isProcessing}
          >
            {isImporting ? <span className={styles.spinner} /> : <FolderInput size={14} />}
            {t('settings.skills.importFolder')}
          </button>

          <button
            className={styles.actionButton}
            onClick={handleRefreshList}
            disabled={isProcessing}
          >
            {isRefreshing ? <span className={styles.spinner} /> : <RefreshCw size={14} />}
            {t('settings.skills.refreshList')}
          </button>
        </div>

        {/* GitHub URL 安装 */}
        <div className={styles.githubInputGroup}>
          <input
            type="text"
            className={styles.githubInput}
            placeholder={t('settings.skills.githubPlaceholder')}
            value={githubUrl}
            onChange={(e) => setGithubUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void handleInstallFromGithub();
              }
            }}
            disabled={isProcessing}
          />
          <button
            className={styles.installButton}
            onClick={handleInstallFromGithub}
            disabled={isProcessing || !githubUrl.trim()}
          >
            {isGithubInstallBusy ? <span className={styles.spinner} /> : <Download size={14} />}
            {t('common.install')}
          </button>
        </div>

        <p className={styles.hint}>{t('settings.skills.githubHint')}</p>

        {/* 安装结果提示 */}
        {visibleResultMessage && (
          <div
            className={cx(
              styles.resultMessage,
              visibleResultMessage.type === 'success' ? styles.resultSuccess : styles.resultError
            )}
          >
            {visibleResultMessage.type === 'success' ? (
              <CheckCircle size={14} />
            ) : (
              <XCircle size={14} />
            )}
            <span className={styles.resultText}>
              {translateDependencyInstallResultMessage(visibleResultMessage.text, t)}
            </span>
          </div>
        )}
      </div>

      {/* 安装前审查确认与安全审查结果 Modal */}
      <ConfirmDialog
        open={pendingAuditConfirm !== null}
        onClose={handleDirectInstallFromConfirm}
        onConfirm={handleStartAuditFromConfirm}
        title={t('settings.skills.auditConfirmTitle')}
        description={t('settings.skills.auditConfirmDescription')}
        cancelText={t('settings.skills.auditConfirmDirectInstall')}
        confirmText={t('settings.skills.auditConfirmStartAudit')}
        variant="warning"
        isLoading={isAuditProcessing}
        disableDismiss
      />

      <SkillAuditModal onDecision={handleAuditDecision} isProcessing={isAuditProcessing} />
    </section>
  );
}

/**
 * Python 环境区域
 */
function EnvironmentSection() {
  const { t } = useI18n();
  const envStatus = useRuntimeStore((s) => s.envStatus);
  const pythonVersion = useRuntimeStore((s) => s.pythonVersion);
  const installProgress = useRuntimeStore((s) => s.installProgress);
  const errorMessage = useRuntimeStore((s) => s.errorMessage);
  const isInstalling = useIsInstalling();
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [showRebuildConfirm, setShowRebuildConfirm] = useState(false);

  // 组件挂载时检测 venv 物理状态，推动 not_checked → not_created 或 ready
  useEffect(() => {
    void reconcileVenvState();
  }, []);

  // 状态文本映射
  const statusLabel: Record<string, string> = {
    not_checked: t('settings.skills.envNotChecked'),
    not_created: t('settings.skills.envNotCreated'),
    creating: t('settings.skills.envCreating'),
    installing_base: t('settings.skills.envInstallingBase'),
    installing_extra: t('settings.skills.envInstallingExtra'),
    ready: t('settings.skills.envReady'),
    error: t('settings.skills.envError'),
    skipped: t('settings.skills.envSkipped'),
  };

  // 状态样式映射
  const statusClass =
    envStatus === 'ready'
      ? styles.envStatusReady
      : envStatus === 'error'
        ? styles.envStatusError
        : styles.envStatusPending;

  // 安装环境（未创建/错误状态下可用）
  const handleSetup = useCallback(async () => {
    try {
      setIsSettingUp(true);
      const { performEnvironmentSetup } =
        await import('@services/planning/skills/external/requirementsProvider');
      await performEnvironmentSetup();
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : t('settings.skills.setupFailed');
      useRuntimeStore.getState().setError(msg);
    } finally {
      setIsSettingUp(false);
    }
  }, [t]);

  // 显示重建确认弹窗
  const handleRebuild = useCallback(() => {
    setShowRebuildConfirm(true);
  }, []);

  // 执行实际的重建操作（由 ConfirmDialog 的 onConfirm 回调触发）
  const executeRebuild = useCallback(async () => {
    setShowRebuildConfirm(false);
    try {
      setIsRebuilding(true);
      const { performEnvironmentRebuild } =
        await import('@services/planning/skills/external/requirementsProvider');
      await performEnvironmentRebuild();
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : t('settings.skills.rebuildFailed');
      useRuntimeStore.getState().setError(msg);
    } finally {
      setIsRebuilding(false);
    }
  }, [t]);

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('settings.skills.pythonEnv')}</h3>

      <div className={styles.envCard}>
        <div className={styles.envRow}>
          <span className={styles.envLabel}>{t('settings.skills.status')}</span>
          <span className={cx(styles.envValue, statusClass)}>
            {statusLabel[envStatus] ?? envStatus}
          </span>
        </div>

        {pythonVersion && (
          <div className={styles.envRow}>
            <span className={styles.envLabel}>{t('settings.skills.pythonVersion')}</span>
            <span className={styles.envValue}>{pythonVersion}</span>
          </div>
        )}

        {errorMessage && (
          <div className={cx(styles.envRow, styles.envRowMultiline)}>
            <span className={styles.envLabel}>{t('settings.skills.error')}</span>
            <span className={cx(styles.envValue, styles.envValueMultiline, styles.envStatusError)}>
              {errorMessage}
            </span>
          </div>
        )}

        {/* 安装进度条 */}
        {isInstalling && installProgress && (
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

        {/* 操作按钮 */}
        <div className={styles.envActions}>
          {/* 安装按钮：未创建/错误状态下显示 */}
          {(envStatus === 'not_created' || envStatus === 'error') && (
            <button
              className={styles.primaryButton}
              onClick={handleSetup}
              disabled={isSettingUp || isInstalling}
            >
              {isSettingUp ? <span className={styles.spinner} /> : <Zap size={12} />}
              {t('settings.skills.installEnvironment')}
            </button>
          )}
          {/* 重建按钮：就绪/错误状态下显示 */}
          {(envStatus === 'ready' || envStatus === 'error') && (
            <button
              className={styles.dangerButton}
              onClick={handleRebuild}
              disabled={isRebuilding || isInstalling}
            >
              {isRebuilding ? <span className={styles.spinner} /> : <RefreshCw size={12} />}
              {t('settings.skills.rebuildEnvironment')}
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={showRebuildConfirm}
        onClose={() => setShowRebuildConfirm(false)}
        onConfirm={executeRebuild}
        title={t('settings.skills.rebuildDialogTitle')}
        description={t('settings.skills.rebuildDialogDescription')}
        confirmText={t('settings.skills.rebuildDialogConfirm')}
        variant="warning"
        isLoading={isRebuilding}
      />
    </section>
  );
}

// ==================== 主组件 ====================

export function SkillSettings() {
  const { t } = useI18n();
  const { toast } = useToast();
  const auditStatus = useRuntimeStore((s) => s.skillAuditStatus);
  const auditMinimized = useRuntimeStore((s) => s.skillAuditMinimized);
  const previousAuditStatusRef = useRef<SkillAuditStatus>(auditStatus);

  // 组件挂载时确保外部技能已扫描注册
  // bootstrapExternalSkills 是幂等的（Promise 锁），重复调用不会重新扫描
  // 这确保设置页打开时 installedSkills 列表从磁盘同步（而非依赖 Zustand 持久化缓存）
  useEffect(() => {
    import('@services/planning/skills/external/ExternalSkillBootstrap')
      .then(({ bootstrapExternalSkills }) => bootstrapExternalSkills())
      .catch((error: unknown) => {
        logger.warn(
          '[SkillSettings] bootstrap 失败:',
          error instanceof Error ? error.message : String(error)
        );
      });
  }, []);

  useEffect(() => {
    const previousStatus = previousAuditStatusRef.current;
    if (auditMinimized && !isAuditFinished(previousStatus) && isAuditFinished(auditStatus)) {
      toast({
        type: auditStatus === 'rejected' ? 'warning' : 'info',
        title: t('settings.skills.auditCompleteToastTitle'),
        description: t('settings.skills.auditCompleteToastDescription'),
        duration: 7000,
      });
    }
    previousAuditStatusRef.current = auditStatus;
  }, [auditMinimized, auditStatus, t, toast]);

  return (
    <div className={styles.container}>
      <SkillAuditStatusBanner />
      <SkillListSection />
      <InstallSection />
      <EnvironmentSection />
    </div>
  );
}
